package gg.pixelkingdomwars.nativeclient.seeker

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class SeekerShardsClaimsHttpTest {
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/seeker/shards-claims.json")!!.readText()).jsonObject
    private val policy = SeekerShardsClaimsPolicy.from(fixture.getValue("policy").jsonObject)
    private val request = fixture.getValue("request").jsonObject
    private val receipt = fixture.getValue("envelope").jsonObject
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, block: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build(); val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        // The owned server listens on IPv4; keep a deliberate dropped reply from making
        // OkHttp try an unbound localhost IPv6 address on the next explicit request.
        val client = OkHttpClient.Builder().dns(object : Dns { override fun lookup(hostname: String) = listOf(java.net.InetAddress.getByName("127.0.0.1")) }).protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { server -> server.protocols = listOf(Protocol.HTTP_1_1); server.useHttps(tls.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private inner class Fixture(server: MockWebServer, client: OkHttpClient) {
        val disk = Memory(); val jar = SessionCookieJar(server.url("/"), disk); val token = jar.sessionToken()
        val identity = StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", receipt.getValue("wallet").jsonPrimitive.content)
        val game = GameApi.withTransport(identity.origin, jar, "test", client)
        val port = game.seekerShardsClaimsPort(identity, token, policy)
        val path = "/seeker/shards/claims/by-key/${request.getValue("idempotencyKey").jsonPrimitive.content}"
        init { jar.saveFromResponse(server.url("/"), listOf(Cookie.parse(server.url("/"), "session=fixture; Path=/; Secure; HttpOnly")!!)) }
    }
    private suspend fun rejects(block: suspend () -> Unit) = assertTrue(runCatching { block() }.isFailure)
    @Test fun `same cookie owner routes exact original body and scoped GET without currency header`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); f.port.requireCurrent(f.identity, f.game.sessionToken())
        server.enqueue(MockResponse().setBody(receipt.toString())); f.port.post(request, {}) {}
        val sent = server.takeRequest(); assertEquals("/api/seeker/shards/claims", sent.path); assertEquals(request, Json.parseToJsonElement(sent.body.readUtf8()))
        assertEquals("session=fixture", sent.getHeader("Cookie")); assertEquals(f.identity.origin, sent.getHeader("Origin")); assertNull(sent.getHeader("X-PKW-Currency"))
        server.enqueue(MockResponse().setBody(receipt.toString())); f.port.get(f.path, emptyMap(), {}) {}; assertEquals("/api${f.path}", server.takeRequest().path)
        server.enqueue(MockResponse().setBody(fixture.getValue("entitlements").toString())); f.port.get("/seeker/shards/entitlements", mapOf("cursor" to request.getValue("idempotencyKey").jsonPrimitive.content), {}) {}
        assertTrue(server.takeRequest().path!!.startsWith("/api/seeker/shards/entitlements?cursor="))
    } }
    @Test fun `unsupported route query body and mismatched token fail before network`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        for (path in listOf("https://other.test", "${f.path}?x=1", "/seeker/shards/claims/by-key/../x")) rejects { f.port.get(path, emptyMap(), {}) {} }
        rejects { f.port.get(f.path, mapOf("cursor" to "bad"), {}) {} }
        rejects { f.port.post(JsonObject(request + ("quantity" to JsonPrimitive("1"))), {}) {} }
        rejects { f.port.requireCurrent(f.identity, SessionCookieJar(server.url("/"), Memory()).sessionToken()) }
        rejects { f.game.seekerShardsClaimsPort(f.identity.copy(origin = "https://wrong.test"), f.token, policy) }
        assertEquals(0, server.requestCount)
    } }
    @Test fun `lost response and redirects do not retry mutation`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)); val dropped = runCatching { f.port.post(request, {}) {} }.exceptionOrNull()
        assertTrue("Expected lost HTTP response, got $dropped", dropped is java.io.IOException)
        val redirect = Fixture(server, client)
        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", server.url("/other")).setBody("{}")); val redirected = runCatching { redirect.port.post(request, {}) {} }.exceptionOrNull()
        assertTrue("Expected original 307, got $redirected", redirected is ApiException && redirected.status == 307)
        assertEquals(2, server.requestCount)
    } }
    @Test fun `owned response drains after session rotation before rejecting obsolete cookies`() {
        lateinit var f: Fixture
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { f.jar.beginAuthentication() } } }) { server, client -> runBlocking {
            f = Fixture(server, client); val before = f.disk.value; var retained = false
            server.enqueue(MockResponse().setChunkedBody(receipt.toString(), 64).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure"))
            rejects { f.port.get(f.path, emptyMap(), {}) { retained = true } }
            assertTrue(retained); assertEquals(before, f.disk.value)
        } }
    }
    @Test fun `cancellation waits for owned durable retention without publishing response cookies`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val before = f.disk.value
        val entered = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1); var retained = false
        server.enqueue(MockResponse().setBody(receipt.toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure"))
        val job = launch(Dispatchers.Default) { f.port.get(f.path, emptyMap(), {}) {
            entered.countDown(); check(release.await(3, java.util.concurrent.TimeUnit.SECONDS)); retained = true
        } }
        try {
            assertTrue(entered.await(3, java.util.concurrent.TimeUnit.SECONDS)); job.cancel()
            assertFalse(job.isCompleted); assertFalse(retained)
        } finally { release.countDown() }
        withTimeout(3000) { job.join() }; assertTrue(retained); assertEquals(before, f.disk.value)
    } }
    @Test fun `final enqueue guard and retained persistence failure propagate without effect replay`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); var calls = 0
        rejects { f.port.post(request, { check(++calls < 2) }) {} }; assertEquals(0, server.requestCount)
        server.enqueue(MockResponse().setBody(receipt.toString())); rejects { withTimeout(3000) { f.port.get(f.path, emptyMap(), {}) { error("storage failed") } } }
        assertEquals(1, server.requestCount)
    } }
    @Test fun `bounded malformed and HTTP error responses never reach receipt retention`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        for (response in listOf(MockResponse().setBody("{"), MockResponse().setBody("[]"), MockResponse().setChunkedBody("x".repeat(131073), 1024), MockResponse().setResponseCode(503).setBody("{}"))) {
            server.enqueue(response); rejects { f.port.get(f.path, emptyMap(), {}) { fail("invalid response") } }
        }
    } }
}
