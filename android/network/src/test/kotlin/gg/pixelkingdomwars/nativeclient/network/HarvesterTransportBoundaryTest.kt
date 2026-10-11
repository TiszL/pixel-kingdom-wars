package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.starter.starterResourceRealms
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import java.io.IOException
import java.util.concurrent.CountDownLatch
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

/** Real HTTPS and durable original source recovery. Synthetic server values are protocol fixtures,
 * not client gameplay constants, positive chain admission or balance approval. */
class HarvesterTransportBoundaryTest {
    private class Memory : SecretStore {
        var bytes: String? = null; var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("durable write failed"); bytes = value }
        override fun clear() { bytes = null }
    }
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val wallet = "11111111111111111111111111111111"
    private val base = id(1); private val key = id(2); private val now = "2026-09-22T12:00:00.000Z"
    private val facility = HarvesterFacility(base, id(3), id(4), now)
    private val policy = HarvesterPolicy(1, 1, "1515", "101", 17, 255, 1, 10000, 2000)
    private val command = HarvesterCommand(HarvesterRequest(key, base, facility.harvesterId, null, 1), facility, "crownlands", policy, null)
    private fun view() = HarvesterView(wallet, base, now, HarvesterFeatures(HarvesterFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), listOf(facility), null, null, policy,
        starterResourceRealms.keys.map { OrdinaryRawStock(it, "9", "1", "10") })
    private inline fun <reified T> raw(value: T) = harvesterJson.encodeToJsonElement(value).jsonObject
    private fun proof(accepted: Boolean = true, wrong: Boolean = false): JsonObject = raw(HarvesterProof(wallet, key, now,
        if (accepted) "accepted" else "unknown", if (accepted) HarvesterReceipt(wallet, command.request.copy(baseId = if (wrong) key else base),
            HarvesterSource(key, base, facility.harvesterId, 1, "crownlands", "crown_iron_ore", now, "2026-09-22T12:04:15.000Z",
                facility.completedBuildJobId, now, HarvesterTerm(id(6), "ab".repeat(32), "2026-09-22T11:00:00.000Z", "2026-09-22T13:00:00.000Z"), policy)) else null,
        if (accepted) HarvesterSettlement(emptyList(), null, null) else null))
    private fun failure(code: String) = """{"error":{"code":"$code","message":"Original refusal"}}"""
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, block: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { server -> server.useHttps(identity.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private inner class Fixture(val server: MockWebServer, client: OkHttpClient) {
        val cookies = Memory(); val jar = SessionCookieJar(server.url("/"), cookies); val token = jar.sessionToken()
        val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
        val memory = Memory(); val identity = HarvesterIdentity(server.url("/").toString().trimEnd('/'), "devnet", wallet)
        private val store = HarvesterStore(memory, identity)
        private val transport = HarvesterTransport(store, object : HarvesterPort {
            override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) = api.getHarvester(path, emptyMap(), token, guard, retain)
            override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit) = api.postHarvester(path, body, token, guard, retain, refusal)
        })
        val currentPath = "/harvesters"
        val postPath = "/harvesters/sources"
        val receiptPath get() = command.receiptPath
        val body get() = command.request.body()
        val code = "HARVESTERS_DISABLED"
        val requests get() = store.requests
        init { store.begin(store.read(), command) }
        suspend fun confirm() { transport.confirm(store.read(), ::view) {} }
        suspend fun check() { transport.check {} }
        fun markAttempt() { store.attempt(store.read()) }
        fun attempted() = store.read().operation!!.attemptRevision != null
        fun refused() = store.read().operation!!.refusal != null
        fun retained(): JsonObject? = HarvesterStore(memory, identity).read().operation!!.proof?.let { raw(it) }
        suspend fun get(path: String, query: Map<String, String>, guard: () -> Unit = {}, retain: ((JsonObject) -> Unit)? = null) = api.getHarvester(path, query, token, guard, retain)
        suspend fun post(path: String, body: JsonObject, guard: () -> Unit = {}) = api.postHarvester(path, body, token, guard, {}, {})
        fun unknown() { server.enqueue(MockResponse().setBody(proof(false).toString())) }
        fun accepted(wrong: Boolean = false) { server.enqueue(MockResponse().setResponseCode(201).setBody(proof(wrong = wrong).toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly")) }
    }

    @Test fun `strict paths queries scalar bodies and immutable sessions refuse before network`() {
        tls { server, client ->
            val f = Fixture(server, client)
            for ((path, query) in listOf("/me" to emptyMap(), f.currentPath to emptyMap(), f.currentPath to mapOf("baseId" to base, "wallet" to wallet),
                f.currentPath to mapOf("baseId" to "bad"), f.receiptPath to mapOf("baseId" to base), "${f.receiptPath}/" to emptyMap(),
                "${f.receiptPath}%2f" to emptyMap(), f.receiptPath.replace(key, "ABCDEF00-0000-4000-8000-000000000002") to emptyMap()))
                assertThrows(Exception::class.java) { runBlocking { f.get(path, query, retain = {}) } }
            assertThrows(Exception::class.java) { runBlocking { f.get(f.receiptPath, emptyMap()) } }
            assertThrows(Exception::class.java) { runBlocking { f.post("/me", f.body) } }
            for (body in listOf(JsonObject(f.body + ("wallet" to JsonPrimitive(wallet))), JsonObject(f.body + ("baseId" to JsonPrimitive(true))),
                JsonObject(f.body + ("policyVersion" to JsonPrimitive("7")))))
                assertThrows(Exception::class.java) { runBlocking { f.post(f.postPath, body) } }
            assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setBody(raw(view()).toString()))
            runBlocking { val result = f.get(f.currentPath, mapOf("baseId" to base)); HarvesterView.from(result) }
            assertEquals("/api${f.currentPath}?baseId=$base", server.takeRequest().path)
            f.jar.beginAuthentication(); assertThrows(SessionSupersededException::class.java) { runBlocking { f.get(f.receiptPath, emptyMap(), retain = {}) } }
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun `actual enqueue rechecks admission after IO without sending an obsolete review`() {
        run {
            var current = true; var checks = 0
            tls(EventListener.Factory { current = false; object : EventListener() {} }) { server, client ->
                val f = Fixture(server, client)
                assertThrows(IllegalStateException::class.java) { runBlocking { f.post(f.postPath, f.body) { checks++; check(current) } } }
                assertEquals(2, checks); assertEquals(0, server.requestCount)
            }
        }
    }
    @Test fun `one exact unpaid POST retains accepted proof without automatic GET retry or currency headers`() {
        tls { server, client ->
            val f = Fixture(server, client); f.unknown(); f.accepted(); runBlocking { f.confirm() }
            assertEquals(proof(), f.retained()); assertEquals(2, server.requestCount)
            val get = server.takeRequest(); assertEquals("GET", get.method); assertEquals("/api${f.receiptPath}", get.path)
            val sent = server.takeRequest(); assertEquals("POST", sent.method); assertEquals("/api${f.postPath}", sent.path)
            assertEquals(f.body.toString(), sent.body.readUtf8()); assertNull(sent.getHeader("x-pkw-currency")); assertNull(sent.getHeader("x-pkw-expected-currency"))
        }
    }
    @Test fun `GET and POST retain only matching original scope before rejecting retired session and cookies`() {
        for (method in listOf("GET", "POST")) for (wrong in listOf(false, true)) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (call.request().method == method) f.jar.beginAuthentication() } } }) { server, client ->
                f = Fixture(server, client); if (method == "POST") f.unknown(); f.accepted(wrong)
                assertThrows(Exception::class.java) { runBlocking { if (method == "POST") f.confirm() else f.check() } }
                assertEquals(!wrong, f.retained() != null); assertNull(f.cookies.bytes); assertNotSame(f.token, f.jar.sessionToken())
                assertEquals(if (method == "POST") 2 else 1, server.requestCount)
            }
        }
    }
    @Test fun `typed first refusal survives cancellation while retry and GET remain uncertain`() {
        for (attempt in listOf("first", "retry", "get")) {
            lateinit var task: Job; val method = if (attempt == "get") "GET" else "POST"
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyEnd(call: Call, byteCount: Long) { if (call.request().method == method) task.cancel() } } }) { server, client -> runBlocking {
                val f = Fixture(server, client); if (attempt == "retry") f.markAttempt(); if (method == "POST") f.unknown()
                server.enqueue(MockResponse().setResponseCode(503).setBody(failure(f.code)).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { if (method == "POST") f.confirm() else f.check() }
                task.start(); withTimeout(5_000) { task.join() }; assertEquals(attempt == "first", f.refused()); assertNull(f.retained())
                assertNull(f.cookies.bytes); assertEquals(if (method == "POST") 2 else 1, server.requestCount)
            } }
        }
    }
    @Test fun `first typed refusal is persisted before replacement session rejects its cookies`() {
        run {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                if (call.request().method == "POST") f.jar.beginAuthentication()
            } } }) { server, client ->
                f = Fixture(server, client); f.unknown()
                server.enqueue(MockResponse().setResponseCode(503).setBody(failure(f.code)).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
                assertThrows(SessionSupersededException::class.java) { runBlocking { f.confirm() } }
                assertTrue(f.refused()); assertTrue(f.attempted()); assertNull(f.retained()); assertNull(f.cookies.bytes); assertEquals(2, server.requestCount)
            }
        }
    }
    @Test fun `cancelled complete original GET keeps positive proof and rejects obsolete cookies`() {
        run {
            lateinit var task: Job
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyEnd(call: Call, byteCount: Long) { task.cancel() } } }) { server, client -> runBlocking {
                val f = Fixture(server, client); f.accepted()
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.check() }; task.start(); withTimeout(5_000) { task.join() }
                assertEquals(proof(), f.retained()); assertNull(f.cookies.bytes); assertEquals(1, server.requestCount)
            } }
        }
    }
    @Test fun `malformed wrong-status and conflicting error bodies stay uncertain through callback and catch`() {
        for (retire in listOf(false, true)) {
            val code = "HARVESTERS_DISABLED"
            for ((status, body) in listOf(503 to """{"error":{"code":"$code","message":true}}""", 503 to """{"error":{"code":true,"message":"No"}}""",
                503 to """{"code":"$code","message":"No"}""", 503 to "{bad-json", 409 to failure(code), 409 to failure("IDEMPOTENCY_BODY_MISMATCH"))) {
                lateinit var f: Fixture
                tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (retire && call.request().method == "POST") f.jar.beginAuthentication() } } }) { server, client ->
                    f = Fixture(server, client); f.unknown(); server.enqueue(MockResponse().setResponseCode(status).setBody(body))
                    assertThrows(Exception::class.java) { runBlocking { f.confirm() } }; assertTrue(f.attempted()); assertFalse(f.refused()); assertNull(f.retained()); assertEquals(2, server.requestCount)
                }
            }
        }
    }
    @Test fun `failed success or refusal persistence prevents cookies and preserves attempted original`() {
        for (accepted in listOf(false, true)) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (call.request().method == "POST") f.memory.fail = true } } }) { server, client ->
                f = Fixture(server, client); f.unknown()
                server.enqueue(MockResponse().setResponseCode(if (accepted) 201 else 503).setBody(if (accepted) proof().toString() else failure(f.code)).addHeader("Set-Cookie", "session=uncommitted; Path=/; Secure; HttpOnly"))
                assertThrows(IOException::class.java) { runBlocking { f.confirm() } }; assertTrue(f.attempted()); assertFalse(f.refused()); assertNull(f.retained()); assertNull(f.cookies.bytes)
                assertEquals(2, server.requestCount)
            }
        }
    }
    @Test fun `owned cancellation drains original body before releasing journal lock or accepting cookies`() {
        run {
            lateinit var f: Fixture; lateinit var task: Job
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val cancelled = java.util.concurrent.atomic.AtomicBoolean()
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                if (call.request().method == "POST") { f.jar.beginAuthentication(); task.cancel(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); cancelled.set(call.isCanceled()) }
            } } }) { server, client -> runBlocking {
                f = Fixture(server, client); f.unknown(); f.accepted()
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.confirm() }; task.start()
                try { assertTrue(entered.await(5, TimeUnit.SECONDS)); assertFalse(task.isCompleted); assertFalse(f.requests.tryLock()); assertNull(f.retained()) }
                finally { release.countDown() }
                withTimeout(5_000) { task.join() }; assertFalse(cancelled.get()); assertEquals(proof(), f.retained()); assertNull(f.cookies.bytes)
                assertTrue(f.requests.tryLock()); f.requests.unlock(); assertEquals(2, server.requestCount)
            } }
        }
    }
    @Test fun `partial response and redirect cannot manufacture proof relay or automatically replay a command`() {
        for (redirect in listOf(false, true)) tls { server, client ->
            val f = Fixture(server, client); f.unknown()
            server.enqueue(if (redirect) MockResponse().setResponseCode(307).addHeader("Location", server.url("/other")).setBody("{}")
                else MockResponse().setResponseCode(201).setBody(proof().toString()).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
            assertThrows(if (redirect) ApiException::class.java else IOException::class.java) { runBlocking { f.confirm() } }
            assertTrue(f.attempted()); assertNull(f.retained()); assertFalse(f.refused()); assertEquals(2, server.requestCount)
        }
    }
    @Test fun `owned stalled refusal times out after cancellation and never supplies terminal evidence`() {
        run {
            lateinit var task: Job
            val owned = CompletableDeferred<Unit>(); val armed = java.util.concurrent.atomic.AtomicBoolean(); val readFailure = java.util.concurrent.atomic.AtomicReference<IOException?>()
            tls(EventListener.Factory { object : EventListener() { override fun responseFailed(call: Call, ioe: IOException) { readFailure.set(ioe) } } }) { server, client -> runBlocking {
                val bounded = client.newBuilder().addInterceptor { chain ->
                    val response = chain.proceed(chain.request()); if (chain.request().method != "POST") return@addInterceptor response
                    val body = requireNotNull(response.body)
                    val source = object : okio.ForwardingSource(body.source()) {
                        override fun read(sink: okio.Buffer, byteCount: Long): Long {
                            if (armed.compareAndSet(false, true)) { timeout().timeout(500, TimeUnit.MILLISECONDS); owned.complete(Unit); task.cancel() }
                            return super.read(sink, byteCount)
                        }
                    }.buffer()
                    response.newBuilder().body(object : ResponseBody() {
                        override fun contentType() = body.contentType(); override fun contentLength() = body.contentLength(); override fun source() = source
                    }).build()
                }.build()
                val f = Fixture(server, bounded); f.unknown(); server.enqueue(MockResponse().setResponseCode(503).setBody(failure(f.code)).setBodyDelay(2, TimeUnit.SECONDS))
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.confirm() }; task.start(); withTimeout(5_000) { owned.await() }; withTimeout(3_000) { task.join() }
                assertTrue(readFailure.get() is java.net.SocketTimeoutException); assertNull(f.retained()); assertFalse(f.refused()); assertTrue(f.attempted()); assertEquals(2, server.requestCount)
            } }
        }
    }
}
