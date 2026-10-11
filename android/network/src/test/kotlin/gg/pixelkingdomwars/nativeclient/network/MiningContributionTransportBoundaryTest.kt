package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.miningcontribution.*
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

/** Real HTTPS adapter boundaries, using synthetic server values rather than game tuning. */
class MiningContributionTransportBoundaryTest {
    private class Memory : SecretStore {
        var bytes: String? = null; var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("durable write failed"); bytes = value }
        override fun clear() { bytes = null }
    }
    private val wallet = "11111111111111111111111111111111"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val key = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-09-22T12:00:00.000Z"
    private fun view() = MiningContributionView(wallet, base, 2, now.take(10), now, true, "free", "200", "0", "200", true,
        miningContributionResourceIds.map { MiningContributionStock(it, "100", "13") }, MiningConsistencyPolicy(3, 20, 60))
    private val identity = MiningContributionIdentity("https://example.test", "devnet", wallet)
    private val command = MiningContributionCommand.review(identity, view(), key, listOf(MiningContributionLine("frost_quartz", "2")))
    private fun proof(accepted: Boolean = true, wrong: Boolean = false) = contributionJson.encodeToJsonElement(
        MiningContributionProof.serializer(), MiningContributionProof(wallet, key, now, if (accepted) "accepted" else "unknown",
            if (accepted) MiningContributionReceipt(key, base, wallet, now.take(10), command.request.copy(baseId = if (wrong) key else base), command.lines, command.totalValue, now) else null, null)).jsonObject
    private fun failure(code: String = "INSUFFICIENT_MINING_RESOURCES") = """{"error":{"code":"$code","message":"Original refusal"}}"""
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
        val memory = Memory(); val identity = MiningContributionIdentity(server.url("/").toString().trimEnd('/'), "devnet", wallet)
        val store = MiningContributionStore(memory, identity)
        val port = object : MiningContributionPort {
            override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) = api.getMiningContribution(path, emptyMap(), token, guard, retain)
            override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit) =
                api.postMiningContribution(path, body, token, guard, retain, refusal)
        }
        val transport = MiningContributionTransport(store, port)
        init { store.begin(store.read(), command) }
        suspend fun confirm() = transport.confirm(store.read(), ::view) {}
        fun unknown() { server.enqueue(MockResponse().setBody(proof(false).toString())) }
        fun accepted(wrong: Boolean = false) { server.enqueue(MockResponse().setResponseCode(201).setBody(proof(wrong = wrong).toString())
            .addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly")) }
    }

    @Test fun `only canonical explicit current and original routes can opt into contribution transport`() {
        tls { server, client ->
            val f = Fixture(server, client)
            for ((path, query) in listOf("/me" to emptyMap(), "/mining/contributions" to emptyMap(),
                "/mining/contributions" to mapOf("baseId" to base, "wallet" to wallet), "/mining/contributions" to mapOf("baseId" to "not-a-uuid"),
                command.receiptPath to mapOf("baseId" to base), "${command.receiptPath}/" to emptyMap(),
                "/mining/contributions/by-key/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" to emptyMap(), "${command.receiptPath}%2f" to emptyMap())) {
                assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getMiningContribution(path, query, f.token, {}, {}) } }
            }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getMiningContribution(command.receiptPath, emptyMap(), f.token, {}) } }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.postMiningContribution("/me", command.request.body(), f.token, {}, {}, {}) } }
            for (body in listOf(JsonObject(command.request.body() + ("actor" to JsonPrimitive(wallet))),
                JsonObject(command.request.body() + ("quantity" to JsonPrimitive("1"))), JsonObject(command.request.body() + ("baseId" to JsonPrimitive("bad"))))) {
                assertThrows(Exception::class.java) { runBlocking { f.api.postMiningContribution("/mining/contributions", body, f.token, {}, {}, {}) } }
            }
            assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setBody(contributionJson.encodeToJsonElement(MiningContributionView.serializer(), view()).toString()))
            runBlocking { MiningContributionView.from(f.api.getMiningContribution("/mining/contributions", mapOf("baseId" to base), f.token, {})) }
            assertEquals("/api/mining/contributions?baseId=$base", server.takeRequest().path)
        }
    }
    @Test fun `enqueue repeats admission after IO and obsolete sessions never send`() {
        var current = true; var checks = 0
        tls(EventListener.Factory { current = false; object : EventListener() {} }) { server, client ->
            val f = Fixture(server, client)
            assertThrows(IllegalStateException::class.java) { runBlocking { f.api.postMiningContribution("/mining/contributions", command.request.body(), f.token, { checks++; check(current) }, {}, {}) } }
            assertEquals(2, checks); assertEquals(0, server.requestCount)
            f.jar.beginAuthentication()
            assertThrows(SessionSupersededException::class.java) { runBlocking { f.api.getMiningContribution(command.receiptPath, emptyMap(), f.token, {}, {}) } }
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun `one exact POST retains accepted body without a followup GET or currency headers`() {
        tls { server, client ->
            val f = Fixture(server, client); f.unknown(); f.accepted()
            runBlocking { f.confirm() }
            assertEquals(proof(), contributionJson.encodeToJsonElement(MiningContributionProof.serializer(), f.store.read().operation!!.proof!!))
            assertEquals(2, server.requestCount); assertEquals("GET", server.takeRequest().method)
            val request = server.takeRequest(); assertEquals("POST", request.method); assertEquals("/api/mining/contributions", request.path)
            assertEquals(command.request.body().toString(), request.body.readUtf8())
            assertNull(request.getHeader("x-pkw-currency")); assertNull(request.getHeader("x-pkw-expected-currency"))
        }
    }
    @Test fun `late GET and POST preserve only matching original proof before rejecting old session cookies`() {
        for (method in listOf("GET", "POST")) for (wrong in listOf(false, true)) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (call.request().method == method) f.jar.beginAuthentication() } } }) { server, client ->
                f = Fixture(server, client); if (method == "POST") f.unknown(); f.accepted(wrong)
                assertThrows(Exception::class.java) { runBlocking { if (method == "POST") f.confirm() else f.transport.check {} } }
                assertEquals(!wrong, MiningContributionStore(f.memory, f.identity).read().operation!!.proof != null)
                assertNull(f.cookies.bytes); assertNotSame(f.token, f.jar.sessionToken()); assertEquals(if (method == "POST") 2 else 1, server.requestCount)
            }
        }
    }
    @Test fun `typed first refusal survives cancellation but retry and GET refusals stay uncertain`() {
        for (kind in listOf("first", "retry", "get")) {
            lateinit var task: Job
            val method = if (kind == "get") "GET" else "POST"
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyEnd(call: Call, byteCount: Long) { if (call.request().method == method) task.cancel() } } }) { server, client -> runBlocking {
                val f = Fixture(server, client); if (kind == "retry") f.store.attempt(f.store.read())
                if (method == "POST") f.unknown()
                server.enqueue(MockResponse().setResponseCode(422).setBody(failure()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { if (method == "POST") f.confirm() else f.transport.check {} }
                task.start(); withTimeout(5_000) { task.join() }
                assertEquals(kind == "first", f.store.read().operation!!.refusal != null); assertNull(f.store.read().operation!!.proof)
                assertNull(f.cookies.bytes); assertEquals(if (method == "POST") 2 else 1, server.requestCount)
            } }
        }
    }
    @Test fun `first typed POST refusal is retained before a replacement session rejects its cookies`() {
        lateinit var f: Fixture
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
            if (call.request().method == "POST") f.jar.beginAuthentication()
        } } }) { server, client ->
            f = Fixture(server, client); f.unknown()
            server.enqueue(MockResponse().setResponseCode(422).setBody(failure()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            assertThrows(SessionSupersededException::class.java) { runBlocking { f.confirm() } }
            assertEquals(MiningContributionRefusal(422, "INSUFFICIENT_MINING_RESOURCES"), f.store.read().operation!!.refusal)
            assertNull(f.cookies.bytes); assertNull(f.store.read().operation!!.proof); assertEquals(2, server.requestCount)
        }
    }
    @Test fun `cancelled original GET retains the full accepted receipt before returning cancellation`() {
        lateinit var task: Job
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyEnd(call: Call, byteCount: Long) { task.cancel() } } }) { server, client -> runBlocking {
            val f = Fixture(server, client); f.accepted()
            task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.transport.check {} }
            task.start(); withTimeout(5_000) { task.join() }
            assertNotNull(MiningContributionStore(f.memory, f.identity).read().operation!!.proof)
            assertNull(f.cookies.bytes); assertEquals(1, server.requestCount)
        } }
    }
    @Test fun `malformed conflicting and wrong-status errors cannot become definitive through callback or catch`() {
        val cases = listOf(422 to """{"error":{"code":"INSUFFICIENT_MINING_RESOURCES","message":true}}""",
            422 to """{"error":{"code":true,"message":"No"}}""", 422 to """{"code":"INSUFFICIENT_MINING_RESOURCES","message":"No"}""",
            422 to "{bad-json", 409 to failure(), 409 to failure("IDEMPOTENCY_BODY_MISMATCH"))
        for (retire in listOf(false, true)) for ((status, body) in cases) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (retire && call.request().method == "POST") f.jar.beginAuthentication() } } }) { server, client ->
                f = Fixture(server, client); f.unknown(); server.enqueue(MockResponse().setResponseCode(status).setBody(body))
                assertThrows(Exception::class.java) { runBlocking { f.confirm() } }
                assertNotNull(f.store.read().operation!!.attemptRevision); assertNull(f.store.read().operation!!.refusal); assertNull(f.store.read().operation!!.proof)
                assertEquals(2, server.requestCount)
            }
        }
    }
    @Test fun `storage failure in success and refusal callback prevents cookies and fails closed`() {
        for (accepted in listOf(false, true)) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (call.request().method == "POST") f.memory.fail = true } } }) { server, client ->
                f = Fixture(server, client); f.unknown()
                server.enqueue(MockResponse().setResponseCode(if (accepted) 201 else 422).setBody(if (accepted) proof().toString() else failure())
                    .addHeader("Set-Cookie", "session=uncommitted; Path=/; Secure; HttpOnly"))
                assertThrows(IOException::class.java) { runBlocking { f.confirm() } }
                assertNotNull(f.store.read().operation!!.attemptRevision); assertNull(f.store.read().operation!!.proof); assertNull(f.store.read().operation!!.refusal)
                assertNull(f.cookies.bytes); assertEquals(2, server.requestCount)
            }
        }
    }
    @Test fun `cancelled owned success drains before releasing shared journal lock and rejects obsolete cookies`() {
        lateinit var f: Fixture; lateinit var task: Job
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val socketCancelled = java.util.concurrent.atomic.AtomicBoolean()
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
            if (call.request().method == "POST") { f.jar.beginAuthentication(); task.cancel(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); socketCancelled.set(call.isCanceled()) }
        } } }) { server, client -> runBlocking {
            f = Fixture(server, client); f.unknown(); f.accepted()
            task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.confirm() }
            task.start()
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS)); assertFalse(task.isCompleted)
                assertFalse("Owned response keeps the shared journal request lock until durable retention", f.store.requests.tryLock())
                assertNull(f.store.read().operation!!.proof)
            } finally { release.countDown() }
            withTimeout(5_000) { task.join() }
            assertFalse(socketCancelled.get()); assertNotNull(f.store.read().operation!!.proof); assertNull(f.cookies.bytes)
            assertTrue(f.store.requests.tryLock()); f.store.requests.unlock(); assertEquals(2, server.requestCount)
        } }
    }
    @Test fun `partial accepted response never supplies proof or triggers another POST`() {
        tls { server, client ->
            val f = Fixture(server, client); f.unknown()
            server.enqueue(MockResponse().setResponseCode(201).setBody(proof().toString()).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
            assertThrows(IOException::class.java) { runBlocking { f.confirm() } }
            assertNull(f.store.read().operation!!.proof); assertNull(f.store.read().operation!!.refusal)
            assertNotNull(f.store.read().operation!!.attemptRevision); assertEquals(2, server.requestCount)
        }
    }
    @Test fun `redirects cannot relay the command or manufacture accepted proof`() {
        tls { server, client ->
            val f = Fixture(server, client); f.unknown()
            server.enqueue(MockResponse().setResponseCode(307).addHeader("Location", server.url("/other")).setBody("{}"))
            assertThrows(ApiException::class.java) { runBlocking { f.confirm() } }
            assertEquals(2, server.requestCount); assertNull(f.store.read().operation!!.proof); assertNull(f.store.read().operation!!.refusal)
        }
    }
    @Test fun `owned cancellation preserves bounded read timeout and partial refusal stays uncertain`() {
        lateinit var task: Job
        val owned = CompletableDeferred<Unit>(); val armed = java.util.concurrent.atomic.AtomicBoolean()
        val readFailure = java.util.concurrent.atomic.AtomicReference<IOException?>()
        tls(EventListener.Factory { object : EventListener() { override fun responseFailed(call: Call, ioe: IOException) { readFailure.set(ioe) } } }) { server, client -> runBlocking {
            val bounded = client.newBuilder().addInterceptor { chain ->
                val response = chain.proceed(chain.request())
                if (chain.request().method != "POST") return@addInterceptor response
                val body = requireNotNull(response.body)
                val source = object : okio.ForwardingSource(body.source()) {
                    override fun read(sink: okio.Buffer, byteCount: Long): Long {
                        if (armed.compareAndSet(false, true)) { timeout().timeout(500, TimeUnit.MILLISECONDS); owned.complete(Unit); task.cancel() }
                        return super.read(sink, byteCount)
                    }
                }.buffer()
                response.newBuilder().body(object : ResponseBody() {
                    override fun contentType() = body.contentType()
                    override fun contentLength() = body.contentLength()
                    override fun source() = source
                }).build()
            }.build()
            val f = Fixture(server, bounded); f.unknown()
            server.enqueue(MockResponse().setResponseCode(422).setBody(failure()).setBodyDelay(2, TimeUnit.SECONDS))
            task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.confirm() }
            task.start(); withTimeout(5_000) { owned.await() }; withTimeout(3_000) { task.join() }
            assertTrue(readFailure.get() is java.net.SocketTimeoutException); assertNull(f.store.read().operation!!.refusal)
            assertNull(f.store.read().operation!!.proof); assertEquals(2, server.requestCount)
        } }
    }
    @Test fun `HTTPS capability three accepts actual active policy two or three without selecting the policy`() {
        tls { server, client ->
            val f = Fixture(server, client)
            for (v in listOf(view(), view().copy(policyVersion = 3, resources = miningContributionResourceIdsV3.map { MiningContributionStock(it, "100", "13") }))) {
                server.enqueue(MockResponse().setBody(contributionJson.encodeToJsonElement(MiningContributionView.serializer(), v).toString()))
                val actual = runBlocking { MiningContributionView.from(f.api.getMiningContribution("/mining/contributions", mapOf("baseId" to base, "catalogueVersion" to "3"), f.token, {})) }
                assertEquals(v.policyVersion, actual.policyVersion)
                assertEquals("/api/mining/contributions?baseId=$base&catalogueVersion=3", server.takeRequest().path)
            }
            for (query in listOf(mapOf("baseId" to base, "catalogueVersion" to "2"), mapOf("baseId" to base, "policyVersion" to "3")))
                assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getMiningContribution("/mining/contributions", query, f.token, {}) } }
            assertEquals(2, server.requestCount)
        }
    }

}
