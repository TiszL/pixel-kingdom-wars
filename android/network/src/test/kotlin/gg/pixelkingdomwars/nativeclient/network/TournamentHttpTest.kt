package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.tournament.*
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

/** Real TLS exercises tournament requests through the existing authenticated cookie owner. */
class TournamentHttpTest {
    private class Memory : SecretStore {
        var value: String? = null
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun clear() { value = null }
    }
    private val row = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterTournamentSigning.json")).readText())
        .jsonObject.getValue("rows").jsonArray.first().jsonObject
    private val operation = row.getValue("operation").jsonObject
    private val original = operation.getValue("original").jsonObject.getValue("operation").jsonObject
    private val wallet = row.getValue("leader").jsonPrimitive.content
    private val operationId = original.getValue("id").jsonPrimitive.content
    private val eventId = original.getValue("eventId").jsonPrimitive.content
    private val requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    private val baseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private val prefix = "/clans/charter/tournaments"
    private val operationPath = "$prefix/operations/$operationId"
    private val byKeyPath = "$prefix/events/$eventId/raids/by-key/$requestId"
    private val raidBody = buildJsonObject { put("baseId",baseId); put("idempotencyKey",requestId) }
    private val cookie = "session=obsolete; Path=/; Secure; HttpOnly"
    private val signedOperation = JsonObject(operation + mapOf("signed" to row.getValue("wire"),"status" to JsonPrimitive("signed")))
    private fun reply(body: JsonElement = operation) = MockResponse().setBody(body.toString()).addHeader("Cache-Control","private, no-store")
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} },
        block: (MockWebServer,OkHttpClient) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val client = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1))
            .sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { server ->
            server.protocols = listOf(Protocol.HTTP_1_1); server.useHttps(identity.sslSocketFactory(),false)
            server.start(); block(server,client)
        } } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private inner class Fixture(server: MockWebServer, client: OkHttpClient) {
        val memory = Memory()
        val jar = SessionCookieJar(server.url("/"),memory)
        val token = jar.sessionToken()
        val identity = StarterIdentity(server.url("/").toString().trimEnd('/'),"devnet",wallet)
        val api = GameApi.withTransport(server.url("/").toString(),jar,"tournament-test",client)
        val charter = api.charterClientPort(identity,token)
        val port = TournamentHttpPort(charter)
        val transport = TournamentTransport(port)
        init { jar.saveFromResponse(server.url("/"),listOf(requireNotNull(Cookie.parse(server.url("/"),"session=original; Path=/; Secure; HttpOnly")))) }
    }

    @Test fun `route query and raid targeting injection is refused before any enqueue`() = tls { server,client ->
        val f = Fixture(server,client)
        for (path in listOf("/me",prefix,"$operationPath?actor=$wallet","$operationPath#x","$operationPath/extra",
            "$operationPath%2f","$prefix/events/not-an-id","$prefix/entries/by-key/${requestId.uppercase()}")) {
            assertThrows(Exception::class.java) { runBlocking { f.port.request("GET",path,emptyMap(),null,{},{}) } }
        }
        for (query in listOf(mapOf("wallet" to wallet),mapOf("cursor" to ""),mapOf("cursor" to "x".repeat(257)),mapOf("cursor" to "with space"))) {
            assertThrows(Exception::class.java) { runBlocking { f.port.request("GET","$prefix/events",query,null,{},{}) } }
        }
        for (field in listOf("target","excludeBaseIds","wallet","stars","reward")) {
            assertThrows(Exception::class.java) { runBlocking {
                f.port.request("POST","$prefix/events/$eventId/raids",emptyMap(),JsonObject(raidBody+(field to JsonPrimitive(baseId))),{},{})
            } }
        }
        assertThrows(Exception::class.java) { runBlocking { f.port.request("POST","$operationPath/prepare",emptyMap(),buildJsonObject { put("blockhash",wallet) },{},{}) } }
        assertThrows(Exception::class.java) { runBlocking { f.port.request("POST","$byKeyPath/cancel",emptyMap(),buildJsonObject { put("refund",true) },{},{}) } }
        assertThrows(Exception::class.java) { runBlocking { f.port.request("GET",byKeyPath,emptyMap(),buildJsonObject {},{},{}) } }
        f.jar.beginAuthentication()
        assertThrows(SessionSupersededException::class.java) { runBlocking { f.port.request("GET",operationPath,emptyMap(),null,{},{}) } }
        assertEquals(0,server.requestCount)
    }

    @Test fun `POST freezes original command and uses the captured GameApi session cookie`() = tls { server,client -> runBlocking {
        val f = Fixture(server,client); val mutable = raidBody.toMutableMap(); val body = JsonObject(mutable)
        val expected = body.toString(); var retained = 0
        server.enqueue(reply().setResponseCode(201).addHeader("Set-Cookie","session=next; Path=/; Secure; HttpOnly"))
        val result = f.port.request("POST","$prefix/events/$eventId/raids",emptyMap(),body,
            { mutable["baseId"] = JsonPrimitive(requestId) }) { raw -> assertEquals(operation,raw); yield(); retained++ }
        assertEquals(operation,result); assertEquals(1,retained); assertEquals(f.identity,f.port.identity)
        val sent = requireNotNull(server.takeRequest(3,TimeUnit.SECONDS))
        assertEquals("POST",sent.method); assertEquals("/api$prefix/events/$eventId/raids",sent.path)
        assertEquals(expected,sent.body.readUtf8()); assertEquals("session=original",sent.getHeader("Cookie"))
        assertEquals(f.identity.origin,sent.getHeader("Origin")); assertEquals("android-native",sent.getHeader("X-PKW-Client"))
        assertEquals("PKW-Native/tournament-test",sent.getHeader("User-Agent")); assertEquals("application/json",sent.getHeader("Accept"))
        server.enqueue(reply()); f.api.get("/me",session=f.token)
        assertEquals("session=next",requireNotNull(server.takeRequest(3,TimeUnit.SECONDS)).getHeader("Cookie"))
        assertEquals(2,server.requestCount)
    } }

    @Test fun `by-key absence stays null while catalogue cursor and cancel retain exact paths`() = tls { server,client -> runBlocking {
        val f = Fixture(server,client); var absent = false
        server.enqueue(reply(JsonNull))
        assertEquals(JsonNull,f.transport.request("GET",byKeyPath,null,{}) { absent = it == JsonNull })
        assertTrue(absent)
        val sent = requireNotNull(server.takeRequest(3,TimeUnit.SECONDS))
        assertEquals("GET",sent.method); assertEquals("/api$byKeyPath",sent.path); assertEquals(0,sent.bodySize)
        val cursor = "next+a/b=="; val query = mutableMapOf("cursor" to cursor)
        val events = buildJsonObject { put("version",1); put("events",buildJsonArray {}); put("nextCursor",JsonNull) }
        server.enqueue(reply(events))
        f.port.request("GET","$prefix/events",query,null,{ query["cursor"] = "changed" }) { assertEquals(events,it) }
        val catalogue = requireNotNull(server.takeRequest(3,TimeUnit.SECONDS))
        assertEquals("/api$prefix/events",catalogue.requestUrl?.encodedPath); assertEquals(cursor,catalogue.requestUrl?.queryParameter("cursor"))
        server.enqueue(reply(buildJsonObject { put("status","cancelled") }))
        f.transport.request("POST","$byKeyPath/cancel",buildJsonObject {},{}) {}
        val cancel = requireNotNull(server.takeRequest(3,TimeUnit.SECONDS))
        assertEquals("POST",cancel.method); assertEquals("/api$byKeyPath/cancel",cancel.path); assertEquals("{}",cancel.body.readUtf8())
        assertEquals(3,server.requestCount)
    } }

    @Test fun `owned signed response drains after session cancellation or lifecycle changes`() {
        for (mode in listOf("session","cancel","lifecycle")) {
            lateinit var job: Job; lateinit var f: Fixture; var active = true; var socketCancelled = false
            tls(EventListener.Factory { object : EventListener() {
                override fun responseBodyStart(call: Call) {
                    when (mode) { "session" -> f.jar.beginAuthentication(); "cancel" -> job.cancel(); else -> active = false }
                    socketCancelled = call.isCanceled()
                }
            } }) { server,client -> runBlocking {
                f = Fixture(server,client); val before = f.memory.value; var retained: JsonElement? = null; var failure: Throwable? = null
                server.enqueue(MockResponse().setChunkedBody(signedOperation.toString(),256).addHeader("Set-Cookie",cookie))
                job = launch(start=CoroutineStart.LAZY) {
                    try { f.transport.request("GET",operationPath,null,{ check(active) }) { raw ->
                        val parsed = TournamentProtocol.operation(raw.jsonObject)
                        yield(); retained = parsed.getValue("signed")
                    } } catch (error: Throwable) { failure = error }
                }
                job.start(); withTimeout(3000) { job.join() }
                assertEquals(row.getValue("wire"),retained); assertNotNull(failure); assertFalse(socketCancelled)
                assertEquals(before,f.memory.value); assertEquals(1,server.requestCount)
            } }
        }
    }

    @Test fun `cancellation cannot return while owned evidence is still being stored`() = tls { server,client -> runBlocking {
        val f = Fixture(server,client); val before = f.memory.value
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var retained = false; var finished = false
        server.enqueue(reply(signedOperation).addHeader("Set-Cookie",cookie))
        val job = launch {
            try { f.transport.request("GET",operationPath,null,{}) { raw ->
                assertEquals(signedOperation,raw); entered.complete(Unit); release.await(); retained = true
            } } finally { finished = true }
        }
        withTimeout(3000) { entered.await() }; job.cancel(); yield(); assertFalse(finished); assertFalse(retained)
        release.complete(Unit); withTimeout(3000) { job.join() }
        assertTrue(retained); assertTrue(finished); assertEquals(before,f.memory.value); assertEquals(1,server.requestCount)
    } }

    @Test fun `failed durable custody does not publish response cookies or return success`() = tls { server,client ->
        val f = Fixture(server,client); val before = f.memory.value; var attempts = 0
        server.enqueue(reply(signedOperation).addHeader("Set-Cookie",cookie))
        assertThrows(IOException::class.java) { runBlocking { f.transport.request("GET",operationPath,null,{}) {
            attempts++; yield(); throw IOException("Custody unavailable")
        } } }
        assertEquals(1,attempts); assertEquals(before,f.memory.value); assertEquals(1,server.requestCount)
    }

    @Test fun `malformed and oversized decoded payloads stay held before evidence callbacks`() = tls { server,client ->
        val f = Fixture(server,client); val before = f.memory.value; var retained = 0
        val oversized = " ".repeat(1_048_577) + operation
        val gzip = okio.Buffer(); okio.GzipSink(gzip).buffer().use { it.writeUtf8(oversized) }
        val responses = listOf(MockResponse().setBody("[]"),MockResponse().setBody("true"),MockResponse().setBody("{"),
            MockResponse().setBody("{\"x\":" + "[".repeat(21) + "null" + "]".repeat(21) + "}"),
            MockResponse().setBody(buildJsonObject { put("unbounded", "x".repeat(4097)) }.toString()),
            MockResponse().setBody("{\"items\":[" + List(10001) { "{}" }.joinToString(",") + "]}"),
            MockResponse().setBody(oversized),MockResponse().setChunkedBody(oversized,8192),
            MockResponse().setBody(gzip).addHeader("Content-Encoding","gzip"))
        for (response in responses) {
            server.enqueue(response.addHeader("Set-Cookie",cookie))
            assertThrows(Exception::class.java) { runBlocking { f.transport.request("GET",operationPath,null,{}) { retained++ } } }
        }
        // The nullable tournament adapter must not loosen ordinary Charter responses.
        server.enqueue(reply(JsonNull).addHeader("Set-Cookie",cookie))
        assertThrows(Exception::class.java) { runBlocking { f.charter.request("GET","/clans/charter/client/creations/$operationId",emptyMap(),null,{}) { retained++ } } }
        assertEquals(0,retained); assertEquals(responses.size+1,server.requestCount); assertEquals(before,f.memory.value)
    }

    @Test fun `redirect and server failures are never followed or retried`() = tls { server,client ->
        val f = Fixture(server,client); val before = f.memory.value; var retained = 0
        for (status in listOf(307,503)) {
            server.enqueue(reply().setResponseCode(status).addHeader("Location","/api$operationPath").addHeader("Set-Cookie",cookie))
            assertThrows(Exception::class.java) { runBlocking { f.transport.request("POST","$operationPath/deliver",buildJsonObject {},{}) { retained++ } } }
        }
        assertEquals(0,retained); assertEquals(2,server.requestCount); assertEquals(before,f.memory.value)
    }

    @Test fun `unowned cancellation and disconnected GET or POST cannot silently retry`() {
        lateinit var job: Job
        tls(EventListener.Factory { object : EventListener() { override fun responseHeadersEnd(call: Call,response: Response) { job.cancel() } } }) { server,client -> runBlocking {
            val f = Fixture(server,client); var retained = false; server.enqueue(reply(signedOperation))
            job = launch(start=CoroutineStart.LAZY) { f.transport.request("GET",operationPath,null,{}) { retained = true } }
            job.start(); withTimeout(3000) { job.join() }; assertFalse(retained); assertEquals(1,server.requestCount)
        } }
        for (method in listOf("GET","POST")) tls { server,client -> runBlocking {
            val f = Fixture(server,client); var retained = false
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(reply(signedOperation))
            assertTrue(runCatching {
                f.transport.request(method,if(method=="GET") operationPath else "$operationPath/deliver",if(method=="GET") null else buildJsonObject {},{}) { retained = true }
            }.isFailure)
            assertFalse(retained); assertEquals(1,server.requestCount)
        } }
    }
}
