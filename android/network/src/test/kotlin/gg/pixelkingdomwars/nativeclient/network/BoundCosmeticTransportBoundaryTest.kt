package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

/** Real TLS transport against recorded private-loopback original bytes. The CAS
 * reply/error bodies are explicit transport fixtures; no Android/art admission. */
class BoundCosmeticTransportBoundaryTest {
    private class Memory : SecretStore {
        var bytes: String? = null
        var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("Fixture durable write failure"); bytes = value }
        override fun clear() { bytes = null }
    }
    private val view by lazy { Json.parseToJsonElement(requireNotNull(javaClass.getResource("/boundcosmetics/final-actual-http.json")).readText()).jsonObject }
    private val originalRaw get() = view.getValue("originals").jsonArray.single().jsonObject
    private val proof get() = BoundCosmeticProof.from(originalRaw)
    private val receipt get() = requireNotNull(proof.receipt)
    private val command get() = BoundCosmeticCommand(receipt.request, receipt.recipe, receipt.appearance)
    private val choice get() = BoundCosmeticPreferenceRequest(command.request.baseId, false, "0")
    private fun choiceReply() = buildJsonObject {
        put("baseId", choice.baseId); put("enabled", false); put("revision", "1")
        put("visual", buildJsonObject { put("state", "available"); put("visual", buildJsonObject { put("version", 1); put("marketAwnings", JsonArray(emptyList())) }) })
    }
    private fun raw(wrong: Boolean = false): JsonObject = if (!wrong) originalRaw else cosmeticJson.encodeToJsonElement(
        BoundCosmeticProof.serializer(), proof.copy(receipt = receipt.copy(request = receipt.request.copy(baseId = command.key)))).jsonObject
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, block: (MockWebServer, OkHttpClient) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { server -> server.useHttps(identity.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private inner class Fixture(val server: MockWebServer, client: OkHttpClient) {
        val cookies = Memory(); val jar = SessionCookieJar(server.url("/"), cookies); val token = jar.sessionToken()
        val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
        val memory = Memory(); val identity = BoundCosmeticIdentity(server.url("/").toString().trimEnd('/'), "devnet", proof.wallet)
        val store = BoundCosmeticStore(memory, identity)
        init { store.attempt(store.begin(store.read(), command)) }
        fun retain(value: JsonObject) { store.accept(command, BoundCosmeticProof.from(value, identity, command)) }
        fun accepted(wrong: Boolean = false) { server.enqueue(MockResponse().setResponseCode(200).setBody(raw(wrong).toString())
            .addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly")) }
        suspend fun original(method: String, guard: () -> Unit = {}) = when (method) {
            "GET" -> api.getBoundCosmetic(command.receiptPath, emptyMap(), token, guard, ::retain)
            "POST" -> api.postBoundCosmetic("/bound-cosmetics/jobs", command.request.body(), token, guard, ::retain)
            else -> error("Unexpected original method")
        }
    }

    @Test fun `only exact current original and strict mutation inputs reach HTTPS`() {
        tls { server, client ->
            val f = Fixture(server, client)
            for ((path, query) in listOf("/me" to emptyMap(), "/bound-cosmetics/" to emptyMap(),
                "/bound-cosmetics" to mapOf("wallet" to proof.wallet), "/bound-cosmetics" to mapOf("baseId" to "bad"),
                command.receiptPath to mapOf("baseId" to command.request.baseId), "${command.receiptPath}/" to emptyMap(),
                "/bound-cosmetics/jobs/by-key/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" to emptyMap(), "${command.receiptPath}%2f" to emptyMap())) {
                assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getBoundCosmetic(path, query, f.token, {}, if (path == "/bound-cosmetics") null else f::retain) } }
            }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getBoundCosmetic(command.receiptPath, emptyMap(), f.token, {}) } }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getBoundCosmetic("/bound-cosmetics", emptyMap(), f.token, {}, f::retain) } }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.postBoundCosmetic("/other", command.request.body(), f.token, {}, f::retain) } }
            for (body in listOf(JsonObject(command.request.body() + ("wallet" to JsonPrimitive(proof.wallet))),
                JsonObject(command.request.body() + ("recipeVersion" to JsonPrimitive("1"))),
                JsonObject(command.request.body() + ("appearanceBindingSha256" to JsonPrimitive("bad"))))) {
                assertThrows(Exception::class.java) { runBlocking { f.api.postBoundCosmetic("/bound-cosmetics/jobs", body, f.token, {}, f::retain) } }
            }
            for (body in listOf(JsonObject(choice.body() + ("enabled" to JsonPrimitive("false"))),
                JsonObject(choice.body() + ("expectedRevision" to JsonPrimitive(0))), JsonObject(choice.body() + ("wallet" to JsonPrimitive(proof.wallet))))) {
                assertThrows(Exception::class.java) { runBlocking { f.api.putBoundCosmeticPreference(body, f.token, {}) } }
            }
            assertEquals(0, server.requestCount)
            for (query in listOf(emptyMap(), mapOf("baseId" to command.request.baseId))) {
                server.enqueue(MockResponse().setBody(view.toString()))
                assertEquals(view, runBlocking { f.api.getBoundCosmetic("/bound-cosmetics", query, f.token, {}) })
                assertEquals("/api/bound-cosmetics" + if (query.isEmpty()) "" else "?baseId=${command.request.baseId}", server.takeRequest().path)
            }
        }
    }

    @Test fun `enqueue repeats lifecycle guard and obsolete session never sends`() {
        for (method in listOf("GET", "POST", "PUT")) {
            var current = true; val checkedStates = mutableListOf<Boolean>()
            tls(EventListener.Factory { current = false; object : EventListener() {} }) { server, client ->
                val f = Fixture(server, client); val guard = { checkedStates += current; check(current) }
                assertThrows(IllegalStateException::class.java) { runBlocking {
                    if (method == "PUT") f.api.putBoundCosmeticPreference(choice.body(), f.token, guard) else f.original(method, guard)
                } }
                // Admission must recheck after call construction. Error routing may
                // check the obsolete view again; extra safety checks are permitted.
                assertEquals(true, checkedStates.first())
                assertTrue(checkedStates.size >= 2 && checkedStates.drop(1).all { !it })
                assertEquals(0, server.requestCount)
                f.jar.beginAuthentication()
                assertThrows(SessionSupersededException::class.java) { runBlocking { f.original("GET") } }
                assertEquals(0, server.requestCount)
            }
        }
    }

    @Test fun `one exact material POST durably retains matching evidence without currency headers or followup requests`() {
        tls { server, client ->
            val f = Fixture(server, client); f.accepted()
            runBlocking { f.original("POST") }
            assertEquals(proof, BoundCosmeticStore(f.memory, f.identity).read().operation!!.proof)
            assertEquals(1, server.requestCount); val request = server.takeRequest()
            assertEquals("POST", request.method); assertEquals("/api/bound-cosmetics/jobs", request.path)
            assertEquals(command.request.body().toString(), request.body.readUtf8())
            assertNull(request.getHeader("x-pkw-currency")); assertNull(request.getHeader("x-pkw-expected-currency"))
        }
    }

    @Test fun `late GET and POST retain only their exact original before session or lifecycle publication is rejected`() {
        for (method in listOf("GET", "POST")) for (sessionChange in listOf(false, true)) for (wrong in listOf(false, true)) {
            lateinit var f: Fixture; var current = true
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                if (sessionChange) f.jar.beginAuthentication() else current = false
            } } }) { server, client ->
                f = Fixture(server, client); f.accepted(wrong)
                assertThrows(Exception::class.java) { runBlocking { f.original(method) { check(current) } } }
                assertEquals(!wrong, BoundCosmeticStore(f.memory, f.identity).read().operation!!.proof != null)
                assertNull(f.cookies.bytes); assertEquals(1, server.requestCount)
            }
        }
    }

    @Test fun `cancelled owned GET and POST drain complete proof before returning and never accept stale cookies`() {
        for (method in listOf("GET", "POST")) {
            lateinit var f: Fixture; lateinit var task: Job
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val socketCancelled = AtomicBoolean()
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                f.jar.beginAuthentication(); task.cancel(); entered.countDown()
                check(release.await(5, TimeUnit.SECONDS)); socketCancelled.set(call.isCanceled())
            } } }) { server, client -> runBlocking {
                f = Fixture(server, client); f.accepted()
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.original(method) }
                task.start()
                try { assertTrue(entered.await(5, TimeUnit.SECONDS)); assertFalse(task.isCompleted); assertNull(f.store.read().operation!!.proof) }
                finally { release.countDown() }
                withTimeout(5_000) { task.join() }
                assertTrue(task.isCancelled); assertFalse(socketCancelled.get())
                assertEquals(proof, BoundCosmeticStore(f.memory, f.identity).read().operation!!.proof)
                assertNull(f.cookies.bytes); assertEquals(1, server.requestCount)
            } }
        }
    }

    @Test fun `attempted HTTP errors and redirects stay uncertain without another mutation`() {
        for (status in listOf(409, 422, 500, 307)) tls { server, client ->
            val f = Fixture(server, client)
            server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":{"code":"INSUFFICIENT_CRAFTING_STOCK","message":"Fixture refusal"}}""")
                .addHeader("Location", server.url("/other")))
            assertThrows(ApiException::class.java) { runBlocking { f.original("POST") } }
            val saved = BoundCosmeticStore(f.memory, f.identity).read(); assertTrue(saved.operation!!.attempted); assertNull(saved.operation!!.proof)
            assertEquals(command, saved.operation!!.command); assertEquals(1, server.requestCount)
        }
    }

    @Test fun `decompressed byte bound rejects known chunked and gzip bodies before original retention`() {
        for (method in listOf("GET", "POST", "PUT")) for (encoding in listOf("known", "chunked", "gzip")) tls { server, client ->
            val f = Fixture(server, client); val body = (if (method == "PUT") choiceReply() else originalRaw).toString() + " ".repeat(32_768)
            val response = MockResponse().addHeader("Content-Type", "application/json")
            when (encoding) {
                "chunked" -> response.setChunkedBody(body, 41)
                "gzip" -> { val buffer = Buffer(); GzipSink(buffer).buffer().use { it.writeUtf8(body) }; response.setBody(buffer).addHeader("Content-Encoding", "gzip") }
                else -> response.setBody(body)
            }
            server.enqueue(response)
            assertThrows(ApiCompatibilityException::class.java) { runBlocking {
                if (method == "PUT") f.api.putBoundCosmeticPreference(choice.body(), f.token, {}) else f.original(method)
            } }
            assertNull(f.store.read().operation!!.proof); assertEquals(1, server.requestCount)
        }
    }

    @Test fun `stale lifecycle hides malformed and oversized transport errors before compatibility publication`() {
        for (method in listOf("GET", "POST", "PUT")) for (oversized in listOf(false, true)) {
            var current = true
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { current = false } } }) { server, client ->
                val f = Fixture(server, client)
                server.enqueue(MockResponse().setBody(if (oversized) originalRaw.toString() + " ".repeat(32_768) else "{incomplete")
                    .addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
                assertThrows(IllegalStateException::class.java) { runBlocking {
                    if (method == "PUT") f.api.putBoundCosmeticPreference(choice.body(), f.token) { check(current) }
                    else f.original(method) { check(current) }
                } }
                assertNull(f.cookies.bytes); assertNull(f.store.read().operation!!.proof); assertEquals(1, server.requestCount)
            }
        }
    }

    @Test fun `CAS PUT is exact guarded and never retried or decorated as a currency command`() {
        tls { server, client ->
            val f = Fixture(server, client); server.enqueue(MockResponse().setBody(choiceReply().toString()))
            assertEquals(choiceReply(), runBlocking { f.api.putBoundCosmeticPreference(choice.body(), f.token, {}) })
            val request = server.takeRequest(); assertEquals("PUT", request.method); assertEquals("/api/bound-cosmetics/awning", request.path)
            assertEquals(choice.body().toString(), request.body.readUtf8()); assertNull(request.getHeader("x-pkw-currency")); assertNull(request.getHeader("x-pkw-expected-currency"))
            assertEquals(1, server.requestCount); assertNull(f.store.read().operation!!.proof)
        }
        tls { server, client ->
            val f = Fixture(server, client)
            server.enqueue(MockResponse().setBody(choiceReply().toString()).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
            assertThrows(IOException::class.java) { runBlocking { f.api.putBoundCosmeticPreference(choice.body(), f.token, {}) } }
            assertEquals(1, server.requestCount); assertEquals("PUT", server.takeRequest().method)
        }
        lateinit var f: Fixture; var current = true
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { current = false } } }) { server, client ->
            f = Fixture(server, client); server.enqueue(MockResponse().setBody(choiceReply().toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            assertThrows(IllegalStateException::class.java) { runBlocking { f.api.putBoundCosmeticPreference(choice.body(), f.token) { check(current) } } }
            assertNull(f.cookies.bytes); assertEquals(1, server.requestCount)
        }
    }

    @Test fun `partial success or failed durable proof retention never publishes cookies or retries POST`() {
        for (storageFailure in listOf(false, true)) tls { server, client ->
            val f = Fixture(server, client); f.memory.fail = storageFailure
            val response = MockResponse().setBody(originalRaw.toString()).addHeader("Set-Cookie", "session=uncommitted; Path=/; Secure; HttpOnly")
            if (!storageFailure) response.setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
            server.enqueue(response)
            assertThrows(IOException::class.java) { runBlocking { f.original("POST") } }
            assertNull(f.store.read().operation!!.proof); assertTrue(f.store.read().operation!!.attempted)
            assertNull(f.cookies.bytes); assertEquals(1, server.requestCount)
        }
    }

    private val wakePair by lazy { Json.parseToJsonElement(requireNotNull(javaClass.getResource("/boundcosmetics/wake-workshop-primary-pair.json")).readText()).jsonObject }
    private val wakeOriginal get() = wakePair.getValue("original").jsonObject
    private val wakeProof get() = BoundCosmeticProof.from(wakeOriginal)
    private val wakeCommand get() = requireNotNull(wakeProof.receipt).let { BoundCosmeticCommand(it.request, it.recipe, it.appearance) }

    @Test fun `Wake paths require their own family and account CAS before opening HTTPS`() {
        tls { server, client ->
            val f = Fixture(server, client)
            for ((path, body) in listOf(
                "/bound-cosmetics/jobs" to wakeCommand.request.body(),
                "/bound-cosmetics/wakes/v1/jobs" to command.request.body(),
                "/bound-cosmetics/wakes/v1/jobs/" to wakeCommand.request.body(),
                "/bound-cosmetics/wakes/v1/jobs" to JsonObject(wakeCommand.request.body() + ("recipeVersion" to JsonPrimitive("1"))))) {
                assertThrows(Exception::class.java) { runBlocking { f.api.postBoundCosmetic(path, body, f.token, {}) {} } }
            }
            for ((path, query) in listOf(
                "/bound-cosmetics/wakes/v1/workshop/" to emptyMap(),
                "/bound-cosmetics/wakes/v1/workshop" to mapOf("wallet" to wakeProof.wallet),
                "/bound-cosmetics/wakes/v1/workshop" to mapOf("baseId" to "bad"))) {
                assertThrows(Exception::class.java) { runBlocking { f.api.getBoundCosmetic(path, query, f.token, {}) } }
            }
            val off = BoundCosmeticWakePreferenceRequest(false, "0").body()
            for (body in listOf(JsonObject(off + ("baseId" to JsonPrimitive(command.request.baseId))),
                JsonObject(off + ("enabled" to JsonPrimitive("false"))), JsonObject(off + ("expectedRevision" to JsonPrimitive(0))))) {
                assertThrows(Exception::class.java) { runBlocking { f.api.putBoundCosmeticWakePreference(body, f.token, {}) } }
            }
            assertThrows(IllegalStateException::class.java) { runBlocking {
                f.api.putBoundCosmeticWakePreference(off, f.token) { error("Lifecycle retired") }
            } }
            assertEquals(0, server.requestCount)
            for (query in listOf(emptyMap(), mapOf("baseId" to wakeCommand.request.baseId))) {
                server.enqueue(MockResponse().setBody(wakePair.getValue("completed").toString()))
                runBlocking { f.api.getBoundCosmetic("/bound-cosmetics/wakes/v1/workshop", query, f.token, {}) }
                assertEquals("GET", server.takeRequest().method)
            }
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun `Wake late accepted POST retains exact separate original before retired publication fails`() {
        var current = true
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { current = false } } }) { server, client ->
            val cookies = Memory(); val jar = SessionCookieJar(server.url("/"), cookies)
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            val identity = BoundCosmeticIdentity(server.url("/").toString().trimEnd('/'), "devnet", wakeProof.wallet)
            val memory = Memory(); val store = BoundCosmeticStore(memory, identity, mode = BoundCosmeticMode.WAKE)
            store.attempt(store.begin(store.read(), wakeCommand))
            server.enqueue(MockResponse().setBody(wakeOriginal.toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            assertThrows(IllegalStateException::class.java) { runBlocking {
                api.postBoundCosmetic("/bound-cosmetics/wakes/v1/jobs", wakeCommand.request.body(), jar.sessionToken(), { check(current) }) {
                    store.accept(wakeCommand, BoundCosmeticProof.from(it, identity, wakeCommand, BoundCosmeticMode.WAKE))
                }
            } }
            assertEquals(wakeProof, BoundCosmeticStore(memory, identity, mode = BoundCosmeticMode.WAKE).read().operation!!.proof)
            assertNull(cookies.bytes); assertEquals(1, server.requestCount)
            val request = server.takeRequest(); assertEquals("/api/bound-cosmetics/wakes/v1/jobs", request.path)
            assertEquals(wakeCommand.request.body().toString(), request.body.readUtf8())
            assertNull(request.getHeader("x-pkw-currency")); assertNull(request.getHeader("x-pkw-expected-currency"))
        }
    }

    @Test fun `Wake free account Off uses its fixed PUT without base currency or automatic conflict replay`() {
        for (status in listOf(200, 409)) tls { server, client ->
            val f = Fixture(server, client); val choice = BoundCosmeticWakePreferenceRequest(false, "1")
            // Exact response is from a different normal-runtime account; transport
            // only routes bytes here. Repository matching owns account/CAS authority.
            val response = if (status == 200) wakePair.getValue("runtime").jsonObject.getValue("preference").toString()
                else """{"error":{"code":"BOUND_COSMETIC_PREFERENCE_CHANGED","message":"Refresh the account setting"}}"""
            server.enqueue(MockResponse().setResponseCode(status).setBody(response))
            if (status == 200) runBlocking { f.api.putBoundCosmeticWakePreference(choice.body(), f.token, {}) }
            else assertThrows(ApiException::class.java) { runBlocking { f.api.putBoundCosmeticWakePreference(choice.body(), f.token, {}) } }
            assertEquals(1, server.requestCount); val request = server.takeRequest()
            assertEquals("PUT", request.method); assertEquals("/api/bound-cosmetics/wakes/v1/preference", request.path)
            assertEquals(choice.body().toString(), request.body.readUtf8())
            assertNull(request.getHeader("x-pkw-currency")); assertNull(request.getHeader("x-pkw-expected-currency"))
            assertNull(f.store.read().operation!!.proof)
        }
    }

}
