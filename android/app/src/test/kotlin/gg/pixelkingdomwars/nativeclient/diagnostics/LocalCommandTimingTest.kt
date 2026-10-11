package gg.pixelkingdomwars.nativeclient.diagnostics

import gg.pixelkingdomwars.nativeclient.network.BattleCommandStage.*
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.zip.ZipInputStream

class LocalCommandTimingTest {
    private var time = 10L
    private val core = LocalCommandTiming { time }.also { it.reset(1) }
    private val session = core.session()
    private val build = "0.4.2:15:dev"
    private fun input() = requireNotNull(core.input(1,session,1000,build))
    private fun records() = requireNotNull(core.sample(1)).records

    @Test fun `storage and receipt stages measure original admitted input without resetting on duplicate or retry`() {
        val ticket = input();time=20;core.bind(ticket,"private-command")
        time=400;core.stage(1,session,"private-command",INTENT_DURABLE)
        time=600;core.stage(1,session,"private-command",ATTEMPT_DURABLE)
        time=610;core.stage(1,session,"private-command",POST_BEGIN)
        time=1000;core.stage(1,session,"private-command",POST_BEGIN)
        time=1600;core.stage(1,session,"private-command",RESPONSE)
        time=1800;core.stage(1,session,"private-command",RECEIPT_DURABLE)
        val values=records().single().stagesMs
        assertEquals(mapOf("original_id_bound" to 10L,"intent_durable" to 390L,"attempt_durable" to 590L,
            "post_begin" to 600L,"response" to 1590L,"receipt_durable" to 1790L),values)
    }
    @Test fun `out of order acknowledgements retain each original input and read recovery does not invent response time`() {
        val first=input();core.bind(first,"one");time=30
        val second=input();core.bind(second,"two");time=50
        core.stage(1,session,"two",RECEIPT_DURABLE);time=90
        core.stage(1,session,"one",RECEIPT_DURABLE);time=100
        core.stage(1,session,"one",RESPONSE)
        val rows=records()
        assertEquals(80L,rows[0].stagesMs["receipt_durable"]);assertEquals(90L,rows[0].stagesMs["response"])
        assertEquals(20L,rows[1].stagesMs["receipt_durable"]);assertFalse("response" in rows[1].stagesMs)
    }
    @Test fun `restored unknown identities never pretend to have an original input`() {
        core.stage(1,session,"restored",POST_BEGIN);core.stage(1,session,"restored",RECEIPT_DURABLE)
        assertFalse(core.hasWork(1));assertNull(core.sample(1))
    }
    @Test fun `clear disable and stale sample acknowledgements cannot restore prior input identities`() {
        val old=input();core.bind(old,"private-old");val oldBatch=requireNotNull(core.sample(1))
        core.reset(2);core.bind(old,"private-old");core.stage(1,session,"private-old",RECEIPT_DURABLE);core.saved(oldBatch)
        assertFalse(core.hasWork(2));assertNull(core.sample(2))
        val fresh=core.input(2,session,2000,build)!!;core.bind(fresh,"fresh")
        assertTrue(core.hasWork(2));assertEquals(1,core.sample(2)!!.records.size)
    }
    @Test fun `session replacement fences delayed binds and responses even when wallet later matches`() {
        val old=input();core.bind(old,"one");core.close(session)
        time=100;core.stage(1,session,"one",RECEIPT_DURABLE);core.bind(old,"late")
        assertNull(core.input(1,session,2000,build));assertFalse("receipt_durable" in records().single().stagesMs)
        val replacement=core.session();val next=core.input(1,replacement,2000,build)!!;core.bind(next,"two")
        core.stage(1,replacement,"two",RECEIPT_DURABLE)
        assertTrue("receipt_durable" in records().last().stagesMs)
    }
    @Test fun `rings and stale tickets cannot overwrite newer observations or sustain idle polling`() {
        val old=input()
        repeat(LocalCommandTiming.LIMIT+10) { core.bind(input(),"id-$it") }
        core.bind(old,"overwritten")
        val batch=core.sample(1)!!;assertEquals(LocalCommandTiming.RECORD_LIMIT,batch.records.size)
        core.saved(batch);assertFalse(core.hasWork(1));assertNull(core.sample(1))
        core.stage(1,session,"overwritten",RECEIPT_DURABLE);assertFalse(core.hasWork(1))
    }
    @Test fun `expired association and backwards clocks cannot fabricate durations`() {
        val ticket=input();core.bind(ticket,"one")
        time=0;core.stage(1,session,"one",POST_BEGIN)
        time=LocalCommandTiming.ASSOCIATION_MS+100;core.stage(1,session,"one",RECEIPT_DURABLE)
        assertEquals(setOf("original_id_bound"),records().single().stagesMs.keys)
    }
    @Test fun `export and retained records reject private or malformed stage fields`() {
        core.bind(input(),"PRIVATE-ORIGINAL-ID")
        val rows=records();val at=1000L
        val unsafe=LocalCommandRecord(at,500,mapOf("https://private/wallet" to 0),build)
        val kept=LocalReportBundle(commands=rows+unsafe).retained(at)
        assertEquals(rows,kept.commands)
        val directory=Files.createTempDirectory("command-report").toFile()
        try {
            val store=LocalReportStore(directory);store.save(kept) {true}
            val loaded=store.load(at);assertEquals(kept,loaded)
            val output=ByteArrayOutputStream();store.export(loaded,output,false) {true}
            val entries=buildMap<String,String> { ZipInputStream(ByteArrayInputStream(output.toByteArray())).use { zip ->
                while(true) {val entry=zip.nextEntry ?: break;put(entry.name,zip.readBytes().decodeToString())}
            } }
            val report=entries.getValue("report.json")
            assertFalse(report.contains("PRIVATE-ORIGINAL-ID"));assertFalse(report.contains("https://"))
            assertTrue(entries.getValue("README.txt").contains("restored commands have no original input"))
        } finally {directory.deleteRecursively()}
    }
    @Test fun `saved idle association is scrubbed by sampling without creating write or poll work`() {
        val ticket=input();core.bind(ticket,"private-id")
        core.saved(core.sample(1)!!);time+=LocalCommandTiming.ASSOCIATION_MS+1
        assertNull(core.sample(1));assertFalse(core.hasWork(1))
        assertNull(ticket.epoch.entries.get(ticket.slot)?.id)
    }
    @Test fun `base A B A renews new inputs while original input ticket remains fenced`() {
        val scope=core.SelectionScope();val first=scope.current(1)!!
        val old=core.input(1,first,1000,build)!!;core.bind(old,"old-A")
        // The gameplay A coordinator can be reused without ever creating B's coordinator.
        val returned=scope.current(3)!!;assertNotSame(first,returned);assertFalse(first.active.get())
        assertNull(scope.current(1));assertSame(returned,scope.current(3));assertTrue(returned.active.get())
        core.stage(1,first,"old-A",RECEIPT_DURABLE)
        val new=core.input(1,returned,2000,build)!!;core.bind(new,"new-A")
        core.stage(1,returned,"new-A",RECEIPT_DURABLE)
        assertFalse("receipt_durable" in records().first().stagesMs)
        assertTrue("receipt_durable" in records().last().stagesMs)
        scope.close();assertNull(scope.current(4))
    }

    @Test fun `transport stages use original monotonic input and never stitch a retry into its first attempt`() {
        core.bind(input(), "private-original"); time = 20
        val observer = requireNotNull(core.transport(1, session, "private-original"))
        time = 25; observer.stage(TRANSPORT_IO_STARTED)
        time = 40; observer.stage(REQUEST_HEADERS_SENT)
        time = 60; observer.stage(RESPONSE_HEADERS_RECEIVED)
        time = 90; observer.stage(RESPONSE_BODY_READ)
        time = 110; observer.stage(RESPONSE_JSON_PARSED)
        assertNull(core.transport(1, session, "private-original"))
        assertNull(core.transport(1, session, "restored-unknown"))
        val values = records().single().stagesMs
        assertEquals(10L, values["transport_admitted"])
        assertEquals(15L, values["transport_io_started"])
        assertEquals(50L, values["response_headers_received"])
        assertEquals(100L, values["response_json_parsed"])
        assertFalse("transport_resumed" in values)
        observer.stage(RESPONSE_BODY_READ)
        assertEquals(80L, records().single().stagesMs["response_body_read"])
    }

    @Test fun `delayed transport callbacks cannot survive clear selection replacement or expiry`() {
        core.bind(input(), "one"); val old = requireNotNull(core.transport(1, session, "one"))
        core.reset(2); old.stage(REQUEST_HEADERS_SENT); assertNull(core.sample(2))
        val ticket = core.input(2, session, 1000, build)!!; core.bind(ticket, "two")
        val current = requireNotNull(core.transport(2, session, "two"))
        core.close(session); current.stage(RESPONSE_CALLBACK)
        assertFalse("response_callback" in core.sample(2)!!.records.single().stagesMs)
        val nextSession = core.session(); core.bind(core.input(2, nextSession, 1000, build)!!, "three")
        val expiring = requireNotNull(core.transport(2, nextSession, "three"))
        time += LocalCommandTiming.ASSOCIATION_MS + 1
        expiring.stage(RESPONSE_BODY_READ); assertNull(core.transport(2, nextSession, "three"))
        assertFalse("response_body_read" in core.sample(2)!!.records.last().stagesMs)
    }

    @Test fun `concurrent attempt admission records only one bounded anonymous transport`() {
        core.bind(input(), "one")
        val start = java.util.concurrent.CountDownLatch(1)
        val accepted = java.util.concurrent.atomic.AtomicInteger()
        val threads = List(8) { Thread {
            start.await(); if (core.transport(1, session, "one") != null) accepted.incrementAndGet()
        } }
        threads.forEach { it.start() }; start.countDown(); threads.forEach { it.join(2000); assertFalse(it.isAlive) }
        assertEquals(1, accepted.get())
        assertEquals(setOf("original_id_bound", "transport_admitted"), records().single().stagesMs.keys)
    }

    @Test fun `transport milestones remain exportable without original identifiers or request metadata`() {
        core.bind(input(), "PRIVATE-ID")
        val observer = requireNotNull(core.transport(1, session, "PRIVATE-ID"))
        listOf(TRANSPORT_IO_STARTED, CALL_ENQUEUED, REQUEST_HEADERS_SENT, REQUEST_BODY_SENT,
            RESPONSE_HEADERS_RECEIVED, RESPONSE_CALLBACK, RESPONSE_BODY_READ, RESPONSE_JSON_PARSED,
            TRANSPORT_RESUMED).forEach { time += 10; observer.stage(it) }
        val rows = records(); val bundle = LocalReportBundle(commands = rows).retained(1000)
        assertEquals(rows, bundle.commands); assertFalse(bundle.toString().contains("PRIVATE-ID"))
        assertFalse(bundle.toString().contains("https://")); assertEquals(11, rows.single().stagesMs.size)
    }

    @Test fun `out of order transport completions stay attached to their own input aliases`() {
        core.bind(input(), "one"); val first = requireNotNull(core.transport(1, session, "one"))
        time = 20; core.bind(input(), "two"); val second = requireNotNull(core.transport(1, session, "two"))
        time = 30; second.stage(RESPONSE_HEADERS_RECEIVED)
        time = 40; second.stage(RESPONSE_JSON_PARSED)
        time = 80; first.stage(RESPONSE_HEADERS_RECEIVED)
        time = 100; first.stage(RESPONSE_JSON_PARSED)
        val rows = records()
        assertEquals(70L, rows[0].stagesMs["response_headers_received"])
        assertEquals(90L, rows[0].stagesMs["response_json_parsed"])
        assertEquals(10L, rows[1].stagesMs["response_headers_received"])
        assertEquals(20L, rows[1].stagesMs["response_json_parsed"])
        assertNotEquals(rows[0].alias, rows[1].alias)
    }

}
