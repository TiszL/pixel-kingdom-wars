package gg.pixelkingdomwars.nativeclient.mining

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

class MiningTaxClaimsContinuationTransportTest {
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private class F : java.io.Closeable {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax/continuation.json")).readText()).jsonObject
        val envelope = MiningTaxClaimsContinuationEnvelope.from(raw); val c = envelope.continuation!!; val key = envelope.parentIdempotencyKey
        val child = MiningTaxClaimsContinuationRequest(c.childPreparation.idempotencyKey, c.childPreparation.caps)
        val server = MockWebServer(); val client: OkHttpClient; val jar: SessionCookieJar; val transport: MiningTaxClaimsTransport; val port: MiningTaxClaimsHttpPort
        var enabled = true
        init {
            val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
            val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build(); val trusted = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
            client = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trusted.sslSocketFactory(), trusted.trustManager).build()
            server.protocols = listOf(Protocol.HTTP_1_1); server.useHttps(serverTls.sslSocketFactory(), false); server.start()
            jar = SessionCookieJar(server.url("/"), Memory()); jar.saveFromResponse(server.url("/"), listOf(Cookie.parse(server.url("/"), "session=fixture; Path=/; Secure; HttpOnly")!!))
            port = MiningTaxClaimsHttpPort(StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", envelope.wallet), jar, jar.sessionToken(), "test", client)
            transport = MiningTaxClaimsTransport(port) { enabled }
        }
        fun reply(v: JsonObject = raw, code: Int = 200) { server.enqueue(MockResponse().setResponseCode(code).setBody(v.toString())) }
        fun unknown() = JsonObject(raw + mapOf("status" to JsonPrimitive("unknown"), "continuation" to JsonNull))
        override fun close() { server.close(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private suspend fun refuses(block: suspend () -> Unit) { assertTrue(runCatching { block() }.isFailure) }
    @Test fun `exact additional child request uses one authenticated POST and paused history uses GET`() = runBlocking { F().use { f ->
        f.reply(); val events = mutableListOf<String>()
        f.transport.continuation(f.key, f.child, {}, {}, { events += "positive" }, { events += "wire" }) { events += "link" }
        val post = f.server.takeRequest(); assertEquals("POST", post.method); assertEquals("/api/claims/mining-tax/continue/${f.key}", post.path)
        assertEquals("session=fixture", post.getHeader("Cookie")); assertEquals(f.child, MiningTaxClaimsContinuationRequest.from(Json.parseToJsonElement(post.body.readUtf8()).jsonObject))
        assertEquals(listOf("positive", "wire", "link"), events)
        f.enabled = false; refuses { f.transport.continuation(f.key, f.child, {}, {}, {}, {}) {} }
        f.reply(); f.transport.continuation(f.key, null, {}, {}, {}, {}) {}
        assertEquals("GET", f.server.takeRequest().method); assertEquals(2, f.server.requestCount)
    } }
    @Test fun `unknown continuation preserves read only recovery without positive hold or automatic replay`() = runBlocking { F().use { f ->
        f.reply(f.unknown()); var observed = false
        f.transport.continuation(f.key, null, {}, { observed = true }, { observed = true }, { fail("Unknown has no setup wire") }) { assertNull(it.continuation) }
        assertFalse(observed); assertEquals(1, f.server.requestCount)
    } }
    @Test fun `positive link and original setup custody drain before malformed adjacent proof or wrong outer actor`() = runBlocking { F().use { f ->
        for (outer in listOf(false, true)) {
            val c = f.raw.getValue("continuation").jsonObject
            f.reply(if (outer) JsonObject(f.raw + ("wallet" to JsonPrimitive(f.c.parentPreparation.identity.keepMint))) else JsonObject(f.raw + ("continuation" to JsonObject(c + ("parentSetup" to JsonPrimitive("broken"))))))
            val events = mutableListOf<String>(); refuses { f.transport.continuation(f.key, null, {}, { events += "unknown" }, { events += "link" }, { events += "wire" }) { fail("Malformed link") } }
            assertEquals("link", events.first()); assertTrue(events.contains("wire")); assertTrue(events.contains("unknown"))
        }
    } }
    @Test fun `non success owned link body retains custody and holds without publishing proof after session retirement`() = runBlocking { F().use { f ->
        f.reply(f.raw, 503); var retained = false; var held = false
        refuses { f.transport.continuation(f.key, null, {}, { held = true }, { held = true }, { retained = true; f.jar.beginAuthentication() }) { fail("Error body cannot publish continuation") } }
        assertTrue(retained); assertTrue(held); assertEquals(1, f.server.requestCount)
    } }
    @Test fun `cancelled owned response waits for original custody before returning`() = runBlocking { F().use { f ->
        f.reply(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var retained = false
        val job = launch { f.transport.continuation(f.key, null, {}, {}, {}, { entered.complete(Unit); release.await(); retained = true }) {} }
        withTimeout(3000) { entered.await() }; job.cancel(); yield(); assertFalse(job.isCompleted); release.complete(Unit); withTimeout(3000) { job.join() }; assertTrue(retained)
    } }
    @Test fun `lost POST never retries and routes and caps stay bounded before enqueue`() = runBlocking { F().use { f ->
        for (path in listOf("/claims/mining-tax/continue/${f.key}?extra=1", "/claims/mining-tax/continue/${f.key}/extra")) refuses { f.port.request("POST", path, Json.encodeToJsonElement(MiningTaxClaimsContinuationRequest.serializer(), f.child).jsonObject, {}, {}) {} }
        refuses { f.transport.continuation(f.key, f.child.copy(caps = f.child.caps.copy(maxFeeLamports = "01")), {}, {}, {}, {}) {} }
        assertEquals(0, f.server.requestCount)
        f.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)); refuses { f.transport.continuation(f.key, f.child, {}, {}, {}, {}) {} }
        assertEquals(1, f.server.requestCount)
    } }
}
