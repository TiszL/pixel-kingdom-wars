package gg.pixelkingdomwars.nativeclient.network

import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

class RealmSalesHttpTest {
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private val key = "00000000-0000-4000-8000-000000000001"
    private val path get() = "/seeker/realm-sales/by-key/$key"
    private val body = buildJsonObject { put("wallet", "11111111111111111111111111111111"); put("idempotencyKey", key); put("preparation", JsonNull); put("wire", JsonNull); put("settlement", JsonNull) }
    private fun request() = buildJsonObject { put("idempotencyKey", key); put("spot", 1); put("realm", 1) }
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, block: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(cert).build(); val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        // Chunk framing exists only on HTTP/1.1. MockWebServer's setChunkedBody
        // bytes are not a valid HTTP/2 body; test the actual decoded boundary.
        val client = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { server -> server.protocols = listOf(Protocol.HTTP_1_1); server.useHttps(identity.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private class Fixture(server: MockWebServer, client: OkHttpClient) {
        val memory = Memory(); val jar = SessionCookieJar(server.url("/"), memory); val token = jar.sessionToken()
        val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
        init { jar.saveFromResponse(server.url("/"), listOf(Cookie.parse(server.url("/"), "session=original; Path=/; Secure; HttpOnly")!!)) }
    }
    @Test fun `only exact original prepare refusal pairs retain before cancellation and never publish obsolete cookies`() {
        for ((status, code) in listOf(400 to "INVALID_INPUT", 422 to "INSUFFICIENT_SOL", 503 to "PHASE_E_DISABLED",
            422 to "REALM_SALE_NO_QUOTA", 422 to "REALM_SALE_UNSOLD", 422 to "REALM_SALE_REALM_UNAVAILABLE")) tls { server, client -> runBlocking {
            val f = Fixture(server, client); val cookies = f.memory.value; var retained = false
            val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var finished = false
            server.enqueue(MockResponse().setResponseCode(status).setBody("{\"error\":{\"code\":\"$code\",\"message\":\"Declined\"}}").addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            val job = launch { try { f.api.postRealmSale("/seeker/realm-sales/prepare", request(), f.token, {}, refusal = {
                assertEquals(status, it.status); assertEquals(code, it.code); entered.complete(Unit); release.await(); retained = true
            }) { fail("A refusal is not a preparation") } } finally { finished = true } }
            withTimeout(3000) { entered.await() }; job.cancel(); yield(); assertFalse(finished)
            release.complete(Unit); withTimeout(3000) { job.join() }; assertTrue(retained); assertEquals(cookies, f.memory.value); assertEquals(1, server.requestCount)
        } }
    }
    @Test fun `owned refusal body survives cancellation or session replacement before parsing`() {
        for (replace in listOf(false, true)) {
            lateinit var job: Job; lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                if (replace) f.jar.beginAuthentication() else job.cancel()
            } } }) { server, client -> runBlocking {
                f = Fixture(server, client); val cookies = f.memory.value; var retained = false
                server.enqueue(MockResponse().setResponseCode(422).setChunkedBody("{\"error\":{\"code\":\"INSUFFICIENT_SOL\",\"message\":\"Declined\"}}", 8)
                    .addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
                job = launch(start = CoroutineStart.LAZY) { runCatching { f.api.postRealmSale("/seeker/realm-sales/prepare", request(), f.token, {}, refusal = { yield(); retained = true }) {} } }
                job.start(); withTimeout(3000) { job.join() }; assertTrue(retained); assertEquals(cookies, f.memory.value); assertEquals(1, server.requestCount)
            } }
        }
    }
    @Test fun `malformed mismatched expanded and nonprepare failures grant no refusal authority`() = tls { server, client ->
        val f = Fixture(server, client); var retained = 0
        val valid = "{\"error\":{\"code\":\"INSUFFICIENT_SOL\",\"message\":\"Declined\"}}"
        val cases = listOf(503 to valid, 401 to valid, 422 to valid.replace("Declined", ""), 422 to valid.replace("Declined", "x".repeat(1025)),
            422 to valid.replace("\"message\":\"Declined\"", "\"message\":1"), 422 to valid.dropLast(1).plus(",\"extra\":true}"),
            422 to valid.replace("\"Declined\"", "\"Declined\",\"extra\":true"), 422 to "{", 422 to "[]", 422 to " ".repeat(32769).plus(valid))
        for ((status, raw) in cases) {
            server.enqueue(MockResponse().setResponseCode(status).setBody(raw))
            assertTrue(runCatching { runBlocking { f.api.postRealmSale("/seeker/realm-sales/prepare", request(), f.token, {}, refusal = { retained++ }) {} } }.isFailure)
        }
        assertTrue(runCatching { runBlocking { f.api.postRealmSale("/seeker/realm-sales/submit", buildJsonObject { put("idempotencyKey", key); put("signedTransaction", Base64.getEncoder().encodeToString(ByteArray(66))) }, f.token, {}, refusal = { retained++ }) {} } }.isFailure)
        assertEquals(0, retained); assertEquals(cases.size, server.requestCount)
    }
    @Test fun `suspending original retention finishes before cancellation can release its owner or accept cookies`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val originalCookies = f.memory.value
        server.enqueue(MockResponse().setBody(body.toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var retained = false; var finished = false
        val job = launch { try { f.api.getRealmSale(path, f.token, {}) { entered.complete(Unit); release.await(); retained = true } } finally { finished = true } }
        withTimeout(3000) { entered.await() }; job.cancel(); yield(); assertFalse(finished); assertFalse(retained)
        release.complete(Unit); withTimeout(3000) { job.join() }
        assertTrue(retained); assertTrue(finished); assertEquals(originalCookies, f.memory.value); assertEquals(1, server.requestCount)
    } }
    @Test fun `body cancellation after response ownership drains original bytes and async evidence without closing socket`() {
        lateinit var job: Job; var socketCancelled = false
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { job.cancel(); socketCancelled = call.isCanceled() } } }) { server, client -> runBlocking {
            val f = Fixture(server, client); var retained = false; server.enqueue(MockResponse().setChunkedBody(body.toString(), 8))
            job = launch(start = CoroutineStart.LAZY) { f.api.getRealmSale(path, f.token, {}) { yield(); retained = true } }
            job.start(); withTimeout(3000) { job.join() }
            assertTrue(retained); assertFalse(socketCancelled); assertEquals(1, server.requestCount)
        } }
    }
    @Test fun `cancellation before callback ownership never starts an evidence drain`() {
        lateinit var job: Job
        tls(EventListener.Factory { object : EventListener() { override fun responseHeadersEnd(call: Call, response: Response) { job.cancel() } } }) { server, client -> runBlocking {
            val f = Fixture(server, client); var retained = false; server.enqueue(MockResponse().setBody(body.toString()))
            job = launch(start = CoroutineStart.LAZY) { f.api.getRealmSale(path, f.token, {}) { retained = true } }
            job.start(); withTimeout(3000) { job.join() }; assertFalse(retained); assertEquals(1, server.requestCount)
        } }
    }
    @Test fun `changed session still awaits owned retention and rejects obsolete cookies and response`() {
        lateinit var f: Fixture
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { f.jar.beginAuthentication() } } }) { server, client ->
            f = Fixture(server, client); val cookies = f.memory.value; var retained = false
            server.enqueue(MockResponse().setBody(body.toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            assertThrows(SessionSupersededException::class.java) { runBlocking { f.api.getRealmSale(path, f.token, {}) { yield(); retained = true } } }
            assertTrue(retained); assertEquals(cookies, f.memory.value)
            val request = server.takeRequest(); assertEquals("session=original", request.getHeader("Cookie")); assertEquals("/api$path", request.path)
        }
    }
    @Test fun `changed lifecycle and failed durable retention cannot publish response cookies`() = tls { server, client ->
        val f = Fixture(server, client); val cookies = f.memory.value
        for (fail in listOf(false, true)) {
            var current = true; var retained = false
            server.enqueue(MockResponse().setBody(body.toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            assertThrows(Exception::class.java) { runBlocking { f.api.getRealmSale(path, f.token, { check(current) }) {
                yield(); if (fail) throw IOException("Durable retention failed"); retained = true; current = false
            } } }
            assertEquals(!fail, retained); assertEquals(cookies, f.memory.value)
        }
    }
    @Test fun `exact routes canonical keys and bounded request shapes reject before enqueue`() = tls { server, client ->
        val f = Fixture(server, client)
        for (bad in listOf("/me", "/seeker/realm-sales", "$path?x=1", "$path/extra", path.replace(key, key.uppercase().replace("0000", "AAAA")), "$path%2f", "/seeker/realm-sales/by-key/no"))
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getRealmSale(bad, f.token, {}) {} } }
        for (bad in listOf(buildJsonObject {}, JsonObject(request() + ("extra" to JsonPrimitive(1))), JsonObject(request() + ("spot" to JsonPrimitive("1"))),
            JsonObject(request() + ("realm" to JsonPrimitive(-1))), JsonObject(request() + ("spot" to JsonPrimitive(9007199254740992L)))))
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.postRealmSale("/seeker/realm-sales/prepare", bad, f.token, {}) {} } }
        for (signed in listOf("not base64", Base64.getEncoder().encodeToString(ByteArray(1233)), Base64.getEncoder().encodeToString(ByteArray(65))))
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.postRealmSale("/seeker/realm-sales/submit", buildJsonObject { put("idempotencyKey", key); put("signedTransaction", signed) }, f.token, {}) {} } }
        assertEquals(0, server.requestCount)
    }
    @Test fun `success posts exactly once and redirects failures and oversized bodies never retain evidence`() = tls { server, client ->
        val f = Fixture(server, client); var retained = 0
        server.enqueue(MockResponse().setBody(body.toString()))
        runBlocking { f.api.postRealmSale("/seeker/realm-sales/prepare", request(), f.token, {}) { yield(); retained++ } }
        assertEquals(1, retained); val sent = server.takeRequest(); assertEquals("POST", sent.method); assertEquals(request().toString(), sent.body.readUtf8())
        val oversized = " ".repeat(32769) + body
        val gzip = okio.Buffer(); okio.GzipSink(gzip).buffer().use { it.writeUtf8(oversized) }
        val cases = listOf(MockResponse().setResponseCode(307).addHeader("Location", "/api/seeker/realm-sales/prepare").setBody(body.toString()),
            MockResponse().setResponseCode(401).setBody(body.toString()), MockResponse().setBody("[]"), MockResponse().setBody("{"),
            MockResponse().setChunkedBody(oversized, 1024), MockResponse().setBody(gzip).addHeader("Content-Encoding", "gzip"))
        for (response in cases) { server.enqueue(response); assertThrows(Exception::class.java) { runBlocking { f.api.postRealmSale("/seeker/realm-sales/prepare", request(), f.token, {}) { retained++ } } } }
        assertEquals(1, retained); assertEquals(cases.size + 1, server.requestCount)
    }
    @Test fun `failure GET drains owned error evidence before retired session and never accepts its cookies`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val original = f.memory.value; var retained = false
        val failurePath = "/seeker/realm-sales/failures/by-key/$key"
        server.enqueue(MockResponse().setResponseCode(503).setBody(body.toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
        val result = runCatching { f.api.getRealmSale(failurePath, f.token, {}) {
            f.jar.beginAuthentication(); retained = true
        } }
        assertTrue(result.isFailure); assertTrue(retained); assertEquals(original, f.memory.value)
        assertEquals(1, server.requestCount); assertEquals("/api$failurePath", server.takeRequest().path)
    } }

}
