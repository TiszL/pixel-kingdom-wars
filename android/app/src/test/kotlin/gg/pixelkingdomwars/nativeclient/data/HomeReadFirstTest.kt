package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.diagnostics.bootHttpLine
import gg.pixelkingdomwars.nativeclient.diagnostics.bootHttpTemplate
import gg.pixelkingdomwars.nativeclient.diagnostics.contentStageDetail
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Demo build on the QA chain lane, cold start 2026-10-06: BOOT_HOME t=2557, then GET /base answered at t=17037 (asked at
 * ~12.7 s); SERVICE_READY at 6.8 s; a red "Fleet berths…" toast at 9 s. Home composed and then waited on everything else:
 * the optional Phase E and chain reads every Home surface starts at sign-in shared OkHttp's 5 calls per host with it (one
 * held by the raid-events stream) and answered 503 only after seconds, and a transient failure of GET /base waited for the
 * next cadence tick. These pin the owner bar: the Home read goes first, is never queued behind an optional read, and a
 * transient 5xx on it is read again at once.
 */
class HomeReadFirstTest {
    private fun main(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()

    private class Lane : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer()
        init {
            server.useHttps(tls.sslSocketFactory(), false)
            // One connection per call (HTTP/1.1), as the per-host limit sees them on the device.
            server.protocols = listOf(okhttp3.Protocol.HTTP_1_1)
            server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                    // The generated BaseDto contract also requires `army`, which the shared fixture omits.
                    "/api/base" -> MockResponse().setBody(kotlinx.serialization.json.JsonObject(baseJson() +
                        ("army" to kotlinx.serialization.json.JsonObject(emptyMap()))).toString())
                    "/api/balances" -> MockResponse().setBody(balancesJson().toString())
                    "/api/tutorial" -> MockResponse().setBody(tutorialJson().toString())
                    // The lane's Phase E reads: a 503 after seconds, or no answer at all (a timeout).
                    "/api/vehicles/fleet", "/api/vehicles/client/assets", "/api/starter-fleet" -> MockResponse().setHeadersDelay(3, TimeUnit.SECONDS)
                        .setResponseCode(503).setBody("""{"error":{"code":"VEHICLE_CLIENT_PROVIDER_UNAVAILABLE","message":"held"}}""")
                    else -> MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                }
            }
            server.start()
        }
        private val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val api = GameApi.withTransport(server.url("/").toString(), SessionCookieJar(server.url("/"), MemoryStore()), "home-first-test", transport)
        val client = SessionApiClient(api, api.sessionToken(), ApiRouting())
        override fun close() { server.shutdown(); transport.connectionPool.evictAll() }
    }

    @Test fun `a 503 or a timeout from any Phase E read never delays the Home read`() = runBlocking {
        Lane().use { lane ->
            // More optional reads than OkHttp's per-host limit, started first, as Home's surfaces do at sign-in.
            val optional = listOf("/vehicles/fleet", "/vehicles/client/assets", "/starter-fleet",
                "/seeker/auctions/current", "/devnet-skr-faucet/status", "/quests").map { path ->
                async(Dispatchers.IO) { runCatching { lane.client.get(path, emptyMap()) } }
            }
            withTimeout(5_000) { while (lane.server.requestCount < 5) kotlinx.coroutines.delay(10) }
            val started = System.nanoTime()
            val home = withTimeout(5_000) { readHome(lane.client, BASE_ID) }
            val tookMs = (System.nanoTime() - started) / 1_000_000
            assertEquals(BASE_ID, home.base.baseId)
            assertTrue("the Home read took $tookMs ms behind held optional reads", tookMs < 1_500)
            assertTrue("every optional read was still held when the Home read answered", optional.none { it.isCompleted })
            optional.forEach { it.cancel() }
        }
    }

    @Test fun `a transient 5xx on the Home read is read again at once, a coded refusal or a long wait is not`() = runBlocking {
        fun api(fail: List<Exception>, path: String = "/base") = FakeApiClient().apply {
            val left = fail.toMutableList()
            onGet("/base") { if (path == "/base" && left.isNotEmpty()) throw left.removeAt(0); baseJson() }
            onGet("/balances") { if (path == "/balances" && left.isNotEmpty()) throw left.removeAt(0); balancesJson() }
            onGet("/tutorial") { tutorialJson() }
        }
        fun FakeApiClient.reads(path: String) = gets.count { it.first == path }
        for (bare in listOf(502, 503, 504)) {
            val f = api(listOf(ApiException(bare, null, "gateway")))
            assertEquals(BASE_ID, readHome(f, BASE_ID).base.baseId); assertEquals("bare $bare: one repeat", 2, f.reads("/base"))
        }
        val balances = api(listOf(ApiException(503, null, "proxy")), "/balances")
        readHome(balances, BASE_ID); assertEquals("/balances is a Home read too", 2, balances.reads("/balances"))
        // Bounded: one repeat, never a loop.
        val twice = api(listOf(ApiException(503, null, "proxy"), ApiException(503, null, "proxy")))
        assertTrue(runCatching { readHome(twice, BASE_ID) }.exceptionOrNull() is ApiException); assertEquals(2, twice.reads("/base"))
        // A server that asks for a real wait, a coded refusal, or no network at all is answered as before: one read.
        val later = api(listOf(ApiException(503, null, "busy", retryAfterSeconds = 30)))
        assertTrue(runCatching { readHome(later, BASE_ID) }.exceptionOrNull() is ApiException); assertEquals(1, later.reads("/base"))
        val coded = api(listOf(ApiException(503, "MAINTENANCE", "maintenance")))
        assertTrue(runCatching { readHome(coded, BASE_ID) }.exceptionOrNull() is ApiException); assertEquals(1, coded.reads("/base"))
        val offline = api(listOf(IOException("offline")))
        assertTrue(runCatching { readHome(offline, BASE_ID) }.exceptionOrNull() is IOException); assertEquals(1, offline.reads("/base"))
    }

    @Test fun `optional reads wait for the first Home read after sign-in, bounded, and nothing else ever waits`() {
        var now: Long? = 1_000L
        val gate = HomeReadGate({ now }, holdMs = 2_000)
        assertTrue("an optional read", gate.holds("GET", "/api/starter-fleet", "application/json"))
        assertTrue(gate.holds("GET", "/api/vehicles/fleet", null))
        assertFalse("the Home read", gate.holds("GET", "/api/base", "application/json"))
        assertFalse(gate.holds("GET", "/api/balances", null)); assertFalse(gate.holds("GET", "/api/me", null))
        assertFalse("a write is never held", gate.holds("POST", "/api/base/buildings", "application/json"))
        assertFalse("an event stream is never held", gate.holds("GET", "/api/bases/b/raid-events", "text/event-stream"))
        assertFalse("not armed before sign-in", gate.holding)
        gate.arm(); assertTrue(gate.holding)
        val waiter = thread { gate.await() }
        waiter.join(150); assertTrue("held while the Home read is out", waiter.isAlive)
        gate.release(); waiter.join(1_000); assertFalse("released by the Home read's answer", waiter.isAlive)
        // Bounded: an armed gate that is never released lets reads go at its deadline.
        val real = HomeReadGate({ System.nanoTime() / 1_000_000 }, holdMs = 200)
        real.arm(); val started = System.nanoTime(); real.await()
        assertTrue("the hold is a bound, not a stall", (System.nanoTime() - started) / 1_000_000 in 150..1_500)
        assertFalse(real.holding)
        // Without an Android clock (JVM) the process gate never arms.
        now = null; val inert = HomeReadGate({ now }); inert.arm(); assertFalse(inert.holding)
    }

    @Test fun `the gate is armed at sign-in, released by the Home read on every outcome, and sits on the game API transport`() {
        val account = main("data/AccountRepository.kt")
        assertTrue(account.indexOf("HomeReadGate.current.arm()") > account.indexOf("BootTimeline.stage(LoadEvent.BOOT_SIGNED_IN, signedInAt)"))
        val base = main("data/BaseRepository.kt")
        assertTrue("released only after /balances has answered", base.indexOf("} finally { HomeReadGate.current.release() }") >
            base.indexOf("BootTimeline.stage(LoadEvent.BOOT_BALANCES, balancesAt)"))
        assertTrue("and in a finally, so a failed Home read never holds them", base.contains("} finally { HomeReadGate.current.release() }"))
        val runtime = main("notifications/NativeMessagingService.kt")
        assertTrue(runtime.contains(".addInterceptor(gg.pixelkingdomwars.nativeclient.data.HomeReadGate.current.interceptor)"))
        assertTrue(runtime.contains(".eventListenerFactory(gg.pixelkingdomwars.nativeclient.diagnostics.BootHttp.listeners)"))
        assertTrue("one transport per process", runtime.contains("client?.let { return it }"))
    }

    @Test fun `every boot read and content stage leaves an account-free line`() {
        assertEquals("/vehicles/fleet", bootHttpTemplate("/api/vehicles/fleet"))
        assertEquals("/base", bootHttpTemplate("/api/base?baseId=b86b557b-bb8f-488b-8b18-035600ba0e4a"))
        assertEquals("/bases/:id/raid-events", bootHttpTemplate("/api/bases/b86b557b-bb8f-488b-8b18-035600ba0e4a/raid-events"))
        assertEquals("a wallet is never printed", "/wallet/:id", bootHttpTemplate("/api/wallet/$WALLET"))
        assertEquals("an all-lowercase identifier is not a route word", "/mail/:id/claim", bootHttpTemplate("/api/mail/alllowercasesecret/claim"))
        assertEquals("/starter-fleet wait=12 ms=3400 code=503", bootHttpLine("/starter-fleet", 12, 3400, 503, null))
        assertEquals("/quests wait=2900 ms=3100 failed=SocketTimeoutException", bootHttpLine("/quests", 2900, 3100, null, "SocketTimeoutException"))
        assertEquals("stage=RENDER_DECODE ms=812 files=0 bytes=0 ok=true", contentStageDetail("RENDER_DECODE", 812, 0, 0, true))
        val content = main("data/ContentRepository.kt")
        assertTrue("candidate builds print each content stage (the Log.i line is debug-only)",
            content.contains("gg.pixelkingdomwars.nativeclient.diagnostics.BootTimeline.contentStage(sample.stage.name, sample.elapsedNanos / 1_000_000,"))
    }
}
