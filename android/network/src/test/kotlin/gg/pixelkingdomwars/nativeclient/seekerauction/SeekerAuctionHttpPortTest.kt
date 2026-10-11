package gg.pixelkingdomwars.nativeclient.seekerauction

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** The real HTTP binding under the auction transport: the phone's bid, withdraw and receipt reads must reach exactly the
 * server's seven routes on the player's own session, never replay a money step, and never lose a drained receipt. */
class SeekerAuctionHttpPortTest {
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private val bid = buildJsonObject { put("round", "1"); put("spot", 0); put("newTotalRaw", "17") }
    private val txPath = "/seeker/auctions/tx/${AuctionFixtures.signature}"
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} },
        configure: OkHttpClient.Builder.() -> Unit = {}, block: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build(); val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        // The owned server listens on IPv4; keep a deliberate dropped reply from making
        // OkHttp try an unbound localhost IPv6 address on the next explicit request.
        val client = OkHttpClient.Builder().dns(object : Dns { override fun lookup(hostname: String) = listOf(java.net.InetAddress.getByName("127.0.0.1")) })
            .protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).apply(configure).build()
        try { MockWebServer().use { server -> server.protocols = listOf(Protocol.HTTP_1_1); server.useHttps(tls.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private inner class Fixture(server: MockWebServer, client: OkHttpClient) {
        val disk = Memory(); val jar = SessionCookieJar(server.url("/"), disk); val token = jar.sessionToken()
        val identity = StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", AuctionFixtures.wallet)
        val game = GameApi.withTransport(identity.origin, jar, "test", client)
        val port = game.seekerAuctionPort(identity, token)
        val auction = SeekerAuctionTransport(port, AuctionFixtures.policy)
        init { jar.saveFromResponse(server.url("/"), listOf(Cookie.parse(server.url("/"), "session=fixture; Path=/; Secure; HttpOnly")!!)) }
    }

    @Test fun `the seven auction calls reach their exact api routes with the session cookie and original bodies`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); f.port.requireCurrent(f.identity, f.game.sessionToken())
        val replies = listOf(AuctionFixtures.round(), AuctionFixtures.round(), AuctionFixtures.refunds(), AuctionFixtures.status(),
            AuctionFixtures.prepared(), AuctionFixtures.prepared(), AuctionFixtures.status(), AuctionFixtures.status())
        replies.forEach { server.enqueue(MockResponse().setBody(it.toString())) }
        f.auction.current(); f.auction.round("1"); f.auction.refunds(SeekerAuctionRefundCursor("9", 2)); f.auction.status(AuctionFixtures.signature)
        f.auction.prepareBid(SeekerAuctionBidRequest("1", 0, "17")); f.auction.prepareWithdrawal(SeekerAuctionWithdrawRequest("1", 2))
        f.auction.submit(SeekerAuctionSubmission.ObserveSignature(AuctionFixtures.signature))
        f.auction.submit(SeekerAuctionSubmission.SignedWire(AuctionFixtures.signedWire, AuctionFixtures.signature))
        val sent = List(replies.size) { server.takeRequest() }
        assertEquals(listOf("GET /api/seeker/auctions/current", "GET /api/seeker/auctions/round/1", "GET /api/seeker/auctions/refunds?round=9&spot=2",
            "GET /api${txPath}", "POST /api/seeker/auctions/bids/prepare", "POST /api/seeker/auctions/withdrawals/prepare",
            "POST /api/seeker/auctions/submit", "POST /api/seeker/auctions/submit"), sent.map { "${it.method} ${it.path}" })
        assertTrue(sent.all { it.getHeader("Cookie") == "session=fixture" && it.getHeader("Origin") == f.identity.origin })
        assertTrue(sent.take(4).all { it.bodySize == 0L })
        assertEquals(bid, Json.parseToJsonElement(sent[4].body.readUtf8()))
        assertEquals(buildJsonObject { put("round", "1"); put("spot", 2) }, Json.parseToJsonElement(sent[5].body.readUtf8()))
        assertEquals(buildJsonObject { put("signature", AuctionFixtures.signature) }, Json.parseToJsonElement(sent[6].body.readUtf8()))
        assertEquals(buildJsonObject { put("signedTransaction", AuctionFixtures.signedWire) }, Json.parseToJsonElement(sent[7].body.readUtf8()))
        assertEquals(replies.size, server.requestCount)
    } }

    @Test fun `anything but the seven auction routes and their exact bodies is refused before the network`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        suspend fun refused(method: String, path: String, query: Map<String, String> = emptyMap(), body: JsonObject? = null) =
            assertTrue("$method $path $query $body", runCatching { f.port.request(method, path, query, body, {}) {} }.isFailure)
        refused("GET", "https://other.test"); refused("GET", "/seeker/auctions/current?x=1"); refused("GET", "/seeker/auctions/current", mapOf("x" to "1"))
        refused("GET", "/seeker/auctions/round/../current"); refused("GET", "/seeker/auctions/round/01"); refused("GET", "/seeker/auctions/tx/bad")
        refused("GET", "/seeker/auctions/refunds", mapOf("round" to "9")); refused("GET", "/seeker/auctions/current", body = bid)
        refused("GET", "/seeker/shards/entitlements"); refused("PUT", "/seeker/auctions/bids/prepare", body = bid)
        refused("POST", "/seeker/auctions/bids/prepare"); refused("POST", "/seeker/auctions/bids/prepare", mapOf("x" to "1"), bid)
        // An injected actor, a string spot or a zero total is not the reviewed bid body.
        refused("POST", "/seeker/auctions/bids/prepare", body = JsonObject(bid + ("wallet" to JsonPrimitive(AuctionFixtures.other))))
        refused("POST", "/seeker/auctions/bids/prepare", body = JsonObject(bid + ("spot" to JsonPrimitive("0"))))
        refused("POST", "/seeker/auctions/bids/prepare", body = JsonObject(bid + ("newTotalRaw" to JsonPrimitive("0"))))
        refused("POST", "/seeker/auctions/submit", body = buildJsonObject { put("signature", AuctionFixtures.signature); put("signedTransaction", AuctionFixtures.signedWire) })
        refused("POST", "/seeker/auctions/submit", body = buildJsonObject { put("signedTransaction", "AQ==") })
        assertTrue(runCatching { f.game.seekerAuctionPort(f.identity.copy(origin = "https://wrong.test"), f.token) }.isFailure)
        assertTrue(runCatching { f.game.seekerAuctionPort(f.identity, SessionCookieJar(server.url("/"), Memory()).sessionToken()) }.isFailure)
        assertTrue(runCatching { f.port.requireCurrent(f.identity, SessionCookieJar(server.url("/"), Memory()).sessionToken()) }.isFailure)
        assertEquals(0, server.requestCount)
    } }

    @Test fun `a lost bid reply is never replayed and a redirect keeps its own status`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        val dropped = runCatching { f.auction.prepareBid(SeekerAuctionBidRequest("1", 0, "17")) }.exceptionOrNull()
        assertTrue("Expected lost HTTP response, got $dropped", dropped is java.io.IOException)
        val redirect = Fixture(server, client)
        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", server.url("/other")).setBody("{}"))
        val redirected = runCatching { redirect.auction.submit(SeekerAuctionSubmission.ObserveSignature(AuctionFixtures.signature)) }.exceptionOrNull()
        assertTrue("Expected original 307, got $redirected", redirected is ApiException && redirected.status == 307)
        assertEquals(2, server.requestCount)
    } }

    @Test fun `server refusals keep their status and code even when a proxy sends no json`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); var retained = false
        server.enqueue(MockResponse().setResponseCode(409)
            .setBody("""{"error":{"message":"Raise the total above the current bid","code":"SEEKER_AUCTION_REFRESH_REQUIRED"}}"""))
        val refresh = runCatching { f.port.request("POST", "/seeker/auctions/bids/prepare", emptyMap(), bid, {}) { retained = true } }.exceptionOrNull() as? ApiException
        assertEquals(409, refresh?.status)
        assertEquals(SeekerAuctionRefusalKind.REFRESH_REQUIRED, SeekerAuctionRefusal.from(refresh!!.status, refresh.code).kind)
        // A gateway outage page must still read as the 503 it is, so the screen offers a later retry instead of failing.
        server.enqueue(MockResponse().setResponseCode(503).setHeader("Content-Type", "text/html").setBody("<html>Service Unavailable</html>"))
        val outage = runCatching { f.port.request("GET", "/seeker/auctions/current", emptyMap(), null, {}) { retained = true } }.exceptionOrNull() as? ApiException
        assertEquals(503, outage?.status)
        assertFalse(retained)
    } }

    @Test fun `a reply that lands as the session rotates is retained but its cookies are not published`() {
        lateinit var f: Fixture
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { f.jar.beginAuthentication() } } }) { server, client -> runBlocking {
            f = Fixture(server, client); val before = f.disk.value; var retained: SeekerAuctionTxStatus? = null
            server.enqueue(MockResponse().setChunkedBody(AuctionFixtures.status().toString(), 16).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure"))
            assertTrue(runCatching { f.auction.submit(SeekerAuctionSubmission.ObserveSignature(AuctionFixtures.signature), retain = { retained = it }) }.isFailure)
            assertEquals(AuctionFixtures.signature, retained?.signature); assertEquals(before, f.disk.value)
        } }
    }

    @Test fun `cancelling the screen waits for the owned receipt to be journaled and publishes no cookies`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val before = f.disk.value
        val entered = CountDownLatch(1); val release = CountDownLatch(1); var retained = false
        server.enqueue(MockResponse().setBody(AuctionFixtures.status().toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure"))
        val job = launch(Dispatchers.Default) { f.port.request("GET", txPath, emptyMap(), null, {}) {
            entered.countDown(); check(release.await(3, TimeUnit.SECONDS)); retained = true
        } }
        try {
            assertTrue(entered.await(3, TimeUnit.SECONDS)); job.cancel()
            assertFalse(job.isCompleted); assertFalse(retained)
        } finally { release.countDown() }
        withTimeout(3000) { job.join() }; assertTrue(retained); assertEquals(before, f.disk.value)
    } }

    @Test fun `a changed session at enqueue sends nothing and a journal failure is not swallowed or replayed`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); var calls = 0
        assertTrue(runCatching { f.port.request("POST", "/seeker/auctions/bids/prepare", emptyMap(), bid, { check(++calls < 2) }) {} }.isFailure)
        assertEquals(0, server.requestCount)
        server.enqueue(MockResponse().setBody(AuctionFixtures.prepared().toString()))
        val failure = runCatching { withTimeout(3000) { f.port.request("POST", "/seeker/auctions/bids/prepare", emptyMap(), bid, {}) { error("storage failed") } } }
        assertEquals("storage failed", failure.exceptionOrNull()?.message)
        assertEquals(1, server.requestCount)
    } }

    @Test fun `malformed oversized and non object replies never reach the journal`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); var retained = false
        for (response in listOf(MockResponse().setBody("{"), MockResponse().setBody("[]"), MockResponse().setChunkedBody("x".repeat(131073), 1024))) {
            server.enqueue(response)
            assertTrue(runCatching { f.port.request("GET", "/seeker/auctions/current", emptyMap(), null, {}) { retained = true } }.isFailure)
        }
        assertFalse(retained); assertEquals(3, server.requestCount)
    } }

    @Test fun `a caller transport cache never stores or replays the private wallet round view`() {
        val dir = java.nio.file.Files.createTempDirectory("seeker-auction-cache").toFile(); val diskCache = okhttp3.Cache(dir, 1L shl 20)
        try {
            tls(configure = { cache(diskCache) }) { server, client -> runBlocking {
                val f = Fixture(server, client)
                repeat(2) { server.enqueue(MockResponse().setBody(AuctionFixtures.round().toString()).addHeader("Cache-Control", "max-age=600")) }
                f.auction.current(); f.auction.current()
                assertEquals(2, server.requestCount); assertEquals(0, diskCache.requestCount()); assertEquals(0, diskCache.writeSuccessCount())
            } }
        } finally { diskCache.close(); dir.deleteRecursively() }
    }

    @Test fun `a refreshed session cookie from an auction reply carries the next call`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        server.enqueue(MockResponse().setBody(AuctionFixtures.round().toString()).addHeader("Set-Cookie", "session=refreshed; Path=/; Secure; HttpOnly"))
        server.enqueue(MockResponse().setBody(AuctionFixtures.round().toString()))
        f.auction.current(); f.auction.current()
        server.takeRequest(); assertEquals("session=refreshed", server.takeRequest().getHeader("Cookie"))
    } }
}
