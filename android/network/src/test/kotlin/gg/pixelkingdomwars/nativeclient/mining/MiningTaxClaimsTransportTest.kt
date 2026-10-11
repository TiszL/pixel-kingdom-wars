package gg.pixelkingdomwars.nativeclient.mining

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.Base64
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

class MiningTaxClaimsTransportTest {
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private fun fixture(kind: String = "combined") = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax/recovery.json")).readText()).jsonObject.getValue(kind).jsonObject
    private fun review() = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax/reviews.json")).readText()).jsonObject.getValue("combined0").jsonObject
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, block: (MockWebServer, OkHttpClient) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(certificate).build(); val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val client = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { s -> s.protocols = listOf(Protocol.HTTP_1_1); s.useHttps(identity.sslSocketFactory(), false); s.start(); block(s, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private inner class Fixture(server: MockWebServer, client: OkHttpClient, val kind: String = "combined") {
        val p = MiningTaxClaimsPreparation.from(fixture(kind).getValue("preparation").jsonObject)
        val memory = Memory(); val jar = SessionCookieJar(server.url("/"), memory); val token = jar.sessionToken()
        val identity = StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", p.wallet)
        val port = MiningTaxClaimsHttpPort(identity, jar, token, "test", client)
        var enabled = true
        val transport = MiningTaxClaimsTransport(port) { enabled }
        val key = p.idempotencyKey
        val request = MiningTaxClaimsPrepareRequest(key, p.round, p.spot, p.caps)
        val wire = MiningTaxClaimsRecoveryEnvelope.from(fixture(kind)).wires.first()
        val signed = Base64.getEncoder().encodeToString(wire.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        init { jar.saveFromResponse(server.url("/"), listOf(Cookie.parse(server.url("/"), "session=fixture; Path=/; Secure; HttpOnly")!!)) }
        fun preparation() = buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", key); put("status", "prepared"); put("preparation", fixture(kind).getValue("preparation")); put("serverNow", fixture(kind).getValue("serverNow")) }
        fun ack(delivery: String = "submitted") = buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", key); put("claimId", p.claimId); put("wire", fixture(kind).getValue("wires").jsonArray[0]); put("delivery", delivery); put("serverNow", fixture(kind).getValue("serverNow")) }
    }
    private suspend fun rejects(block: suspend () -> Unit) = assertTrue(runCatching { block() }.isFailure)
    @Test fun `exact authenticated routes carry original request and bytes once with expected private headers`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); var prepared = 0; server.enqueue(MockResponse().setBody(f.preparation().toString()))
        f.transport.preparation(f.request, 256, true, {}) { prepared++ }
        var sent = server.takeRequest(); assertEquals("/api/claims/mining-tax/prepare", sent.path); assertEquals("POST", sent.method)
        assertEquals("session=fixture", sent.getHeader("Cookie")); assertEquals(f.identity.origin, sent.getHeader("Origin")); assertEquals("android-native", sent.getHeader("X-PKW-Client")); assertNull(sent.getHeader("x-pkw-currency"))
        val body = Json.parseToJsonElement(sent.body.readUtf8()).jsonObject; assertEquals(f.key, body.getValue("idempotencyKey").jsonPrimitive.content); assertEquals(setOf("idempotencyKey", "round", "spot", "caps"), body.keys)
        server.enqueue(MockResponse().setBody(f.preparation().toString())); f.transport.preparation(f.request, 256, false, {}) { prepared++ }
        assertEquals("/api/claims/mining-tax/prepare/by-key/${f.key}", server.takeRequest().path)
        server.enqueue(MockResponse().setBody(review().toString())); assertEquals("ready", f.transport.review(f.p, 0, {}).status)
        assertEquals("/api/claims/mining-tax/review/by-key/${f.key}/0", server.takeRequest().path)
        server.enqueue(MockResponse().setBody(f.ack().toString())); var wires = 0; f.transport.submit(f.key, f.signed, {}, {}, { wires++ }) {}
        sent = server.takeRequest(); assertEquals("/api/claims/mining-tax/submit", sent.path); assertEquals(f.signed, Json.parseToJsonElement(sent.body.readUtf8()).jsonObject.getValue("signedTransaction").jsonPrimitive.content)
        assertEquals(2, prepared); assertEquals(1, wires); assertEquals(4, server.requestCount)
    } }
    @Test fun `paused mining blocks mutations but preserves historical GET recovery and review`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); f.enabled = false
        rejects { f.transport.preparation(f.request, 256, true, {}) {} }; rejects { f.transport.submit(f.key, f.signed, {}, {}, {}) {} }
        server.enqueue(MockResponse().setBody(f.preparation().toString())); f.transport.preparation(f.request, 256, false, {}) {}
        server.enqueue(MockResponse().setBody(fixture().toString())); var held = false; f.transport.saved(f.key, {}, { held = true }) {}
        server.enqueue(MockResponse().setBody(review().toString())); f.transport.review(f.p, 0, {})
        assertTrue(held); assertEquals(3, server.requestCount)
    } }
    @Test fun `all five recoveries synchronously mark positive before nested validation and durable retain`() = tls { server, client -> runBlocking {
        for (kind in listOf("claim", "combined", "split", "setup", "aboveQuote")) {
            val f = Fixture(server, client, kind)
            server.enqueue(MockResponse().setBody(fixture(kind).toString())); val events = mutableListOf<String>()
            f.transport.saved(f.key, {}, { events += "positive:$it" }) { events += "retain" }
            assertEquals("retain", events.last()); assertTrue(events.first().startsWith("positive:"))
        }
        val f = Fixture(server, client)
        val broken = JsonObject(fixture() + ("settlement" to JsonPrimitive("broken"))); server.enqueue(MockResponse().setBody(broken.toString()))
        var held = false; rejects { f.transport.saved(f.key, {}, { held = true }) { fail("Invalid receipt") } }; assertTrue(held)
    } }
    @Test fun `malformed and ambiguous owned successes latch before refusal while ordinary prepared responses do not`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        for (body in listOf("{", "[]", "[".repeat(3000) + "0" + "]".repeat(3000), JsonObject(fixture() + ("status" to JsonPrimitive("something-new"))).toString())) {
            var held = false; server.enqueue(MockResponse().setBody(body)); rejects { f.transport.saved(f.key, {}, { held = true }) {} }; assertTrue(held)
        }
        val prepared = JsonObject(fixture() + mapOf("status" to JsonPrimitive("prepared"), "wires" to JsonArray(emptyList()), "settlement" to JsonNull))
        var held = false; server.enqueue(MockResponse().setBody(prepared.toString())); f.transport.saved(f.key, {}, { held = true }) {}; assertFalse(held)
    } }
    @Test fun `wrong actor key and changed original submit bytes never reach accepted result`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        for ((field, value) in listOf("wallet" to f.p.identity.keepMint, "idempotencyKey" to f.p.claimId)) {
            server.enqueue(MockResponse().setBody(JsonObject(fixture() + (field to JsonPrimitive(value))).toString()))
            rejects { f.transport.saved(f.key, {}, {}) { fail("Wrong original") } }
        }
        val changed = f.signed.dropLast(4) + "AAAA"; server.enqueue(MockResponse().setBody(f.ack().toString()))
        rejects { f.transport.submit(f.key, changed, {}, {}, { fail("Changed wire") }) {} }
    } }
    @Test fun `valid late wire is retained before malformed adjacent acknowledgement and cookie publication`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val cookies = f.memory.value; var held = false; var signed = false
        server.enqueue(MockResponse().setBody(JsonObject(f.ack("settled") + ("reason" to JsonPrimitive("BAD"))).toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
        rejects { f.transport.submit(f.key, f.signed, {}, { held = true }, { signed = true }) { fail("Malformed ack") } }
        assertTrue(held); assertTrue(signed); assertEquals(cookies, f.memory.value)
    } }
    @Test fun `saved original custody survives malformed adjacent receipt or outer actor before full recovery refusal`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        for ((field, value) in listOf("settlement" to JsonPrimitive("broken"), "wallet" to JsonPrimitive(f.p.identity.keepMint))) {
            val events = mutableListOf<String>(); val cookies = f.memory.value
            server.enqueue(MockResponse().setBody(JsonObject(fixture() + (field to value)).toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            rejects { f.transport.saved(f.key, {}, { events += "observed" }, retainWire = { assertEquals(f.wire, it); events += "wire" }) { fail("Malformed recovery") } }
            assertEquals("observed", events.first()); assertTrue(events.contains("wire")); assertEquals(cookies, f.memory.value)
        }
    } }
    @Test fun `saved wire callback rejects a different nested request or actor before retaining anything`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        for ((field, value) in listOf("wallet" to f.p.identity.keepMint, "idempotencyKey" to f.p.claimId)) {
            val badWire = JsonObject(fixture().getValue("wires").jsonArray[0].jsonObject + (field to JsonPrimitive(value)))
            server.enqueue(MockResponse().setBody(JsonObject(fixture() + ("wires" to JsonArray(listOf(badWire)))).toString()))
            var held = false; rejects { f.transport.saved(f.key, {}, { held = true }, retainWire = { fail("Wrong nested attribution") }) {} }; assertTrue(held)
        }
    } }
    @Test fun `saved wire retention drains through cancellation before adjacent malformed receipt is refused`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var retained = false
        server.enqueue(MockResponse().setBody(JsonObject(fixture() + ("settlement" to JsonPrimitive("broken"))).toString()))
        val job = launch { f.transport.saved(f.key, {}, {}, retainWire = { entered.complete(Unit); release.await(); retained = true }) { fail("Malformed receipt") } }
        withTimeout(3000) { entered.await() }; job.cancel(); yield(); assertFalse(job.isCompleted)
        release.complete(Unit); withTimeout(3000) { job.join() }; assertTrue(retained)
    } }
    @Test fun `setup acknowledgement latches its observed ordinal before parsing without inventing unknown claim progress`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client, "setup"); val observations = mutableListOf<Int?>(); var signed = false
        server.enqueue(MockResponse().setBody(f.ack("setup").toString()))
        f.transport.submit(f.key, f.signed, {}, { observations += it }, { assertEquals(listOf(0), observations); signed = true }) {}
        assertTrue(signed); assertEquals(listOf(0), observations)
    } }
    @Test fun `independently attributed original wire survives invalid adjacent top level actor while result is refused`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); var signed = false; var held = false
        server.enqueue(MockResponse().setBody(JsonObject(f.ack() + ("wallet" to JsonPrimitive(f.p.identity.keepMint))).toString()))
        rejects { f.transport.submit(f.key, f.signed, {}, { held = true }, { signed = true }) { fail("Wrong actor acknowledgement") } }
        assertTrue(signed); assertTrue(held)
    } }
    @Test fun `mutation switch and view invalidation during response retain evidence before refusing current action`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); var current = true; var signed = false; val cookies = f.memory.value
        server.enqueue(MockResponse().setBody(f.ack().toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
        rejects { f.transport.submit(f.key, f.signed, { check(current) }, {}, { signed = true; current = false; f.enabled = false }) {} }
        assertTrue(signed); assertEquals(cookies, f.memory.value); assertEquals(1, server.requestCount)
    } }
    @Test fun `owned callback failure propagates promptly without hanging continuation or publishing cookies`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val cookies = f.memory.value
        server.enqueue(MockResponse().setBody(fixture().toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
        val result = runCatching { withTimeout(3000) { f.transport.saved(f.key, {}, {}) { throw AssertionError("Fixture persistence failure") } } }
        assertTrue(result.exceptionOrNull() is AssertionError); assertEquals(cookies, f.memory.value)
    } }
    @Test fun `owned response retention finishes before cancelled scope returns or cookies are accepted`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val cookies = f.memory.value; val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var retained = false; var finished = false
        server.enqueue(MockResponse().setBody(fixture().toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
        val job = launch { try { f.transport.saved(f.key, {}, {}) { entered.complete(Unit); release.await(); retained = true } } finally { finished = true } }
        withTimeout(3000) { entered.await() }; job.cancel(); yield(); assertFalse(finished); release.complete(Unit); withTimeout(3000) { job.join() }
        assertTrue(retained); assertEquals(cookies, f.memory.value); assertEquals(1, server.requestCount)
    } }
    @Test fun `session replacement during body read retains original evidence then refuses obsolete response`() {
        lateinit var f: Fixture
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { f.jar.beginAuthentication() } } }) { server, client -> runBlocking {
            f = Fixture(server, client); val cookies = f.memory.value; var retained = false
            server.enqueue(MockResponse().setChunkedBody(fixture().toString(), 128).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            rejects { f.transport.saved(f.key, {}, {}) { yield(); retained = true } }
            assertTrue(retained); assertEquals(cookies, f.memory.value)
            rejects { f.transport.saved(f.key, {}, {}) {} }; assertEquals(1, server.requestCount)
        } }
    }
    @Test fun `direct port rejects foreign routes query tricks expanded bodies and insecure origin before enqueue`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        for (path in listOf("/me", "https://other.test/claims/mining-tax/prepare", "/claims/mining-tax/by-key/${f.key}?x=1", "/claims/mining-tax/by-key/${f.key}/extra", "/claims/mining-tax/by-key/${f.key}%2f", "/claims/mining-tax/review/by-key/${f.key}/2"))
            rejects { f.port.request("GET", path, null, {}, {}) {} }
        val body = buildJsonObject { put("idempotencyKey", f.key); put("signedTransaction", f.signed); put("extra", true) }
        rejects { f.port.request("POST", "/claims/mining-tax/submit", body, {}, {}) {} }
        for (origin in listOf("http://localhost", "https://localhost/path", "https://user@localhost", "https://localhost?x=1")) rejects { MiningTaxClaimsHttpPort(f.identity.copy(origin = origin), f.jar, f.token, "test", client) }
        assertEquals(0, server.requestCount)
    } }
    @Test fun `redirects decompressed byte excess errors and dropped responses never retry or publish cookies`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val excess = " ".repeat(32769) + fixture(); val gzip = okio.Buffer(); okio.GzipSink(gzip).buffer().use { it.writeUtf8(excess) }
        val cases = listOf(MockResponse().setResponseCode(307).addHeader("Location", "/api/claims/mining-tax/submit"), MockResponse().setResponseCode(401).setBody("{}"), MockResponse().setChunkedBody(excess, 1024), MockResponse().setBody(gzip).addHeader("Content-Encoding", "gzip"), MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        for (response in cases) { server.enqueue(response); rejects { f.transport.submit(f.key, f.signed, {}, {}, {}) {} } }
        assertEquals(cases.size, server.requestCount)
    } }
    @Test fun `failure history is a cookie authenticated bounded GET even when mining is paused`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); f.enabled = false
        val r = JsonObject(fixture() + mapOf("status" to JsonPrimitive("signed"), "settlement" to JsonNull))
        server.enqueue(MockResponse().setBody(buildJsonObject { put("recovery", r); put("failures", JsonArray(emptyList())) }.toString()))
        var retained = false; var held = false
        f.transport.failures(f.key, {}, { held = true }) { assertTrue(it.failures.isEmpty()); retained = true }
        val request = server.takeRequest(); assertEquals("GET", request.method); assertEquals("/api/claims/mining-tax/failures/by-key/${f.key}", request.path)
        assertEquals("session=fixture", request.getHeader("Cookie")); assertTrue(retained); assertFalse(held)
        rejects { f.port.request("GET", "/claims/mining-tax/failures/by-key/${f.key}?extra=1", null, {}, {}) {} }
    } }
    @Test fun `failure ordinal is held and original wire retained before malformed adjacent receipt or outer actor`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client)
        for (badActor in listOf(false, true)) {
            val r = JsonObject(fixture() + mapOf("status" to JsonPrimitive("signed"), "settlement" to JsonNull,
                "wallet" to JsonPrimitive(if (badActor) f.p.identity.keepMint else f.p.wallet)))
            val raw = buildJsonObject { put("recovery", r); putJsonArray("failures") { add(buildJsonObject { put("ordinal", 0); put("receipt", "broken") }) } }
            server.enqueue(MockResponse().setBody(raw.toString())); val events = mutableListOf<String>()
            rejects { f.transport.failures(f.key, {}, { events += "hold:$it" }, { assertEquals(f.wire, it); events += "wire" }, failureObserved = { events += "failure" }) { fail("Malformed failure") } }
            assertEquals("failure", events.first()); assertEquals("hold:0", events[1]); assertTrue(events.contains("wire"))
        }
    } }
    @Test fun `failure wire evidence drains before cancellation and obsolete session can return`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var retained = false
        server.enqueue(MockResponse().setBody(buildJsonObject { put("recovery", fixture()); put("failures", JsonPrimitive("broken")) }.toString()))
        val job = launch { f.transport.failures(f.key, {}, {}, { entered.complete(Unit); release.await(); retained = true }) {} }
        withTimeout(3000) { entered.await() }; f.jar.beginAuthentication(); job.cancel(); yield(); assertFalse(job.isCompleted)
        release.complete(Unit); withTimeout(3000) { job.join() }; assertTrue(retained)
    } }

    @Test fun `S3 bounded saved and failure rosters attempt later custody after one malformed sibling`() = tls { server, client -> runBlocking {
        val f = Fixture(server, client, "split")
        for (failure in listOf(false, true)) {
            val original = fixture("split"); val wires = original.getValue("wires").jsonArray
            val recovery = JsonObject(original + ("wires" to JsonArray(listOf(JsonPrimitive("malformed"), wires[1]))))
            val raw = if (failure) buildJsonObject { put("recovery", recovery); put("failures", JsonPrimitive("broken")) } else recovery
            server.enqueue(MockResponse().setBody(raw.toString())); val kept = mutableListOf<Long>()
            rejects { if (failure) f.transport.failures(f.key, {}, {}, { kept += it.ordinal }) {} else f.transport.saved(f.key, {}, {}, { kept += it.ordinal }) {} }
            assertEquals(listOf(1L), kept)
        }
    } }

}
