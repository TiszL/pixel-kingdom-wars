package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import gg.pixelkingdomwars.nativeclient.network.BattleCommandStage.*

class BattleCommandTransportTimingTest {
    private val path = "/raids/11111111-1111-4111-8111-111111111111/commands"
    private val body = jsonBody("clientCommandId" to "private-original")
    private val stages = Collections.synchronizedList(mutableListOf<BattleCommandStage>())
    private fun observed() = synchronized(stages) { stages.toList() }
    private fun observer(action: (BattleCommandStage) -> Unit = { stages += it }) = object : BattleCommandTiming {
        override fun input(): BattleInputTiming? = null
        override fun stage(id: String, stage: BattleCommandStage) = Unit
        override fun transport(id: String): BattleCommandTransportTiming {
            assertEquals("private-original", id)
            return BattleCommandTransportTiming(action)
        }
    }
    private class Store : SecretStore {
        private var value: String? = null
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun clear() { value = null }
    }
    private class Fixture(listener: EventListener = EventListener.NONE) : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        private val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListener(listener).build()
        val api = GameApi(server.url("/").toString(), SessionCookieJar(server.url("/"), Store()), "timing-test", transport)
        override fun close() { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }

    @Test fun `actual headers callback body read parse and caller return have distinct milestones`() = runBlocking {
        val bodyStarted = CompletableDeferred<Unit>()
        val releaseBody = CountDownLatch(1)
        val delegated = Collections.synchronizedList(mutableListOf<String>())
        Fixture(object : EventListener() {
            override fun callStart(call: Call) { delegated += "start" }
            override fun requestBodyEnd(call: Call, byteCount: Long) { delegated += "request" }
            override fun responseHeadersEnd(call: Call, response: Response) { delegated += "headers" }
            override fun responseBodyStart(call: Call) {
                delegated += "body-start"; bodyStarted.complete(Unit)
                check(releaseBody.await(5, TimeUnit.SECONDS)) { "Body gate was not released" }
            }
            override fun responseBodyEnd(call: Call, byteCount: Long) { delegated += "body-end" }
            override fun callEnd(call: Call) { delegated += "end" }
        }).use { f ->
            f.server.enqueue(MockResponse().setBody("{\"accepted\":true}"))
            val result = async { f.api.postBattle(path, body, f.api.sessionToken(), observer()) }
            try {
                withTimeout(5000) { bodyStarted.await() }
                assertEquals(listOf(TRANSPORT_IO_STARTED, CALL_ENQUEUED, REQUEST_HEADERS_SENT,
                    REQUEST_BODY_SENT, RESPONSE_HEADERS_RECEIVED, RESPONSE_CALLBACK), observed())
                assertFalse(result.isCompleted)
                releaseBody.countDown()
                assertTrue(result.await().flag("accepted"))
                assertEquals(listOf(RESPONSE_BODY_READ, RESPONSE_JSON_PARSED, TRANSPORT_RESUMED), observed().takeLast(3))
                assertEquals(listOf("start", "request", "headers", "body-start", "body-end", "end"), delegated.toList())
                val sent = f.server.takeRequest()
                assertEquals(body.toString(), sent.body.readUtf8())
                assertEquals("POST", sent.method); assertEquals("/api$path", sent.path)
            } finally { releaseBody.countDown(); result.cancelAndJoin() }
        }
    }

    @Test fun `IO parsing can finish while caller dispatcher remains occupied`() = runBlocking {
        val arrived = CompletableDeferred<Unit>(); val releaseResponse = CountDownLatch(1)
        val parsed = CompletableDeferred<Unit>(); val callerBlocked = CompletableDeferred<Unit>()
        val releaseCaller = CountDownLatch(1)
        Fixture().use { f -> Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { caller ->
            f.server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    arrived.complete(Unit)
                    check(releaseResponse.await(5, TimeUnit.SECONDS))
                    return MockResponse().setBody("{}")
                }
            }
            val order = async(caller) { f.api.postBattle(path, body, f.api.sessionToken(), observer {
                stages += it; if (it == RESPONSE_JSON_PARSED) parsed.complete(Unit)
            }) }
            withTimeout(5000) { arrived.await() }
            val block = launch(caller) { callerBlocked.complete(Unit); check(releaseCaller.await(5, TimeUnit.SECONDS)) }
            try {
                withTimeout(5000) { callerBlocked.await() }; releaseResponse.countDown()
                withTimeout(5000) { parsed.await() }
                assertFalse(TRANSPORT_RESUMED in observed()); assertFalse(order.isCompleted)
                releaseCaller.countDown(); order.await(); block.join()
                assertEquals(TRANSPORT_RESUMED, observed().last())
            } finally { releaseResponse.countDown(); releaseCaller.countDown(); order.cancelAndJoin(); block.cancelAndJoin() }
        } }
    }

    @Test fun `disabled or unrelated requests keep original listeners and never gain a timing tag`() = runBlocking {
        val tags = Collections.synchronizedList(mutableListOf<BattleCommandTransportTiming?>())
        val calls = AtomicInteger()
        Fixture(object : EventListener() { override fun callStart(call: Call) { tags += call.request().tag(BattleCommandTransportTiming::class.java) } }).use { f ->
            val disabled = object : BattleCommandTiming {
                override fun input(): BattleInputTiming? = null
                override fun stage(id: String, stage: BattleCommandStage) = Unit
                override fun transport(id: String): BattleCommandTransportTiming? { calls.incrementAndGet(); return null }
            }
            repeat(4) { f.server.enqueue(MockResponse().setBody("{}")) }
            f.api.postBattle(path, body, f.api.sessionToken(), disabled)
            f.api.postBattle("/ordinary", body, f.api.sessionToken(), disabled)
            f.api.post(path, body); f.api.get(path)
            assertEquals(1, calls.get()); assertEquals(4, tags.size); assertTrue(tags.all { it == null })
            val original = object : EventListener() {}
            val call = OkHttpClient().newCall(Request.Builder().url(f.server.url("/unused")).build())
            assertSame(original, commandTimingListener(EventListener.Factory { original }).create(call))
        }
    }

    @Test fun `observer exceptions cannot cancel a command or replace its HTTP failure`() = runBlocking {
        Fixture().use { f ->
            val broken = observer { throw CancellationException("Optional observer failed") }
            f.server.enqueue(MockResponse().setBody("{\"accepted\":true}"))
            assertTrue(f.api.postBattle(path, body, f.api.sessionToken(), broken).flag("accepted"))
            f.server.enqueue(MockResponse().setResponseCode(409).setBody("{\"error\":{\"code\":\"RAID_CLOCK_STALE\",\"message\":\"Wait\"}}"))
            try { f.api.postBattle(path, body, f.api.sessionToken(), broken); fail("HTTP failure changed") }
            catch (error: ApiException) { assertEquals(409, error.status); assertEquals("RAID_CLOCK_STALE", error.code) }
            assertEquals(2, f.server.requestCount)
        }
    }

    @Test fun `cancellation still closes slow body without fabricating parse or resume milestones`() = runBlocking {
        val reading = CompletableDeferred<Unit>(); val cancelled = AtomicInteger()
        Fixture(object : EventListener() {
            override fun responseBodyStart(call: Call) { reading.complete(Unit) }
            override fun canceled(call: Call) { cancelled.incrementAndGet() }
        }).use { f ->
            // MockWebServer throttles the incoming POST too. Admit its complete small body,
            // then stall the much larger response so this checks body cancellation, not upload.
            f.server.enqueue(MockResponse().setBody("{\"padding\":\"${"x".repeat(1000)}\"}").throttleBody(64, 1, TimeUnit.SECONDS))
            val order = launch { f.api.postBattle(path, body, f.api.sessionToken(), observer()) }
            withTimeout(5000) { reading.await() }; withTimeout(2000) { order.cancelAndJoin() }
            assertTrue(order.isCancelled); assertTrue(cancelled.get() > 0)
            assertFalse(RESPONSE_BODY_READ in observed()); assertFalse(RESPONSE_JSON_PARSED in observed())
            assertFalse(TRANSPORT_RESUMED in observed()); assertEquals(1, f.server.requestCount)
        }
    }

    @Test fun `lost acknowledgement records only reached boundaries and never retries command`() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            f.server.enqueue(MockResponse().setBody("{}"))
            try { f.api.postBattle(path, body, f.api.sessionToken(), observer()); fail("Lost response accepted") }
            catch (_: IOException) { }
            assertTrue(REQUEST_BODY_SENT in observed()); assertFalse(RESPONSE_HEADERS_RECEIVED in observed())
            assertFalse(RESPONSE_JSON_PARSED in observed()); assertEquals(1, f.server.requestCount)
        }
    }

    @Test fun `real coordinator captures timing only after original intent and attempt are durable`() = runBlocking {
        Fixture().use { f ->
            val store = PendingBattleStore(Store())
            val raid = path.split('/')[2]
            store.put(PendingBattle("wallet", "base", raidId = raid,
                writes = listOf(PendingBattleWrite("private-original", path, body))))
            val timing = object : BattleCommandTiming {
                override fun input(): BattleInputTiming? = error("Retry cannot create an input")
                override fun stage(id: String, stage: BattleCommandStage) { stages += stage }
                override fun transport(id: String): BattleCommandTransportTiming {
                    val saved = store.get("wallet", "base")!!.writes.single()
                    assertTrue(saved.attempted); assertEquals("private-original", saved.id); assertEquals(body, saved.body)
                    assertEquals(listOf(ATTEMPT_DURABLE, POST_BEGIN), observed())
                    return BattleCommandTransportTiming { stages += it }
                }
            }
            f.server.enqueue(MockResponse().setBody("{\"command\":{\"clientCommandId\":\"private-original\",\"sequence\":0}}"))
            val coordinator = BattleCoordinator("wallet", "base", 15, store, f.api, timing = timing)
            coordinator.retry("private-original")
            assertEquals(listOf(TRANSPORT_RESUMED, RESPONSE, RECEIPT_DURABLE), observed().takeLast(3))
            assertTrue(store.get("wallet", "base")!!.writes.isEmpty())
            assertEquals(1, f.server.requestCount); assertEquals(body.toString(), f.server.takeRequest().body.readUtf8())
        }
    }
}
