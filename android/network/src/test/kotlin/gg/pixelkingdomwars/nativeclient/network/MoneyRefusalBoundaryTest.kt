package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.*
import okio.buffer
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real HTTPS + the durable engine: current view/session state must never erase original evidence. */
class MoneyRefusalBoundaryTest {
    private class Disk : SecretStore {
        var raw: String? = null; var writes = 0; var beforeWrite: () -> Unit = {}
        override fun read() = raw
        override fun write(value: String) { beforeWrite(); raw = value; writes++ }
        override fun clear() { beforeWrite(); raw = null; writes++ }
    }
    private val wallet = "11111111111111111111111111111111"
    private val base = "22345678-1234-4123-8123-123456789012"
    private val key = "12345678-1234-4123-8123-123456789012"
    private data class Case(val spec: MoneyOpSpec<*>, val intent: PendingIntent, val status: Int, val code: String)
    private fun cases(): List<Case> {
        val recruitment = HeroRecruitmentSpec("devnet")
        return listOf(
            Case(HeroUpgradeSpec, HeroUpgradeSpec.intent(wallet, base, "vex", key, 2, "37", "GEMS"), 409, "HERO_PRICE_CHANGED"),
            Case(HeroRecoverySpec, HeroRecoverySpec.intent(wallet, base, "vex", key, "7", "2026-09-21T12:00:00Z", "KEEP"), 409, "HERO_NOT_RECOVERING"),
            Case(GemsFromKeepSpec, GemsFromKeepSpec.intent(wallet, key, "10"), 422, "INSUFFICIENT_KEEP"),
            Case(GemsToShardsSpec, GemsToShardsSpec.intent(wallet, base, key, "10"), 422, "INSUFFICIENT_GEMS"),
            Case(GemsTaskClaimSpec, GemsTaskClaimSpec.intent(wallet, "starter-task", key), 409, "CLAIM_ALREADY_SETTLED"),
            Case(recruitment, recruitment.intent(wallet, HeroRecruitmentRequest(key, base, "heroaltar", 10, 11, false, "37"),
                HeroAltarDefinition("vex", "heroaltar", "Vex", "item_hero_vex", "37", 5, 2, 30)), 503, "HERO_RECRUITMENT_DISABLED"),
        )
    }
    private fun failure(code: String, currency: String? = null) = buildJsonObject { put("error", buildJsonObject {
        put("code", code); put("message", "Original refusal"); currency?.let { put("expectedCurrency", it) }
    }) }.toString()
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, protocols: List<Protocol> = listOf(Protocol.HTTP_2, Protocol.HTTP_1_1), block: (MockWebServer, OkHttpClient) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).protocols(protocols).build()
        try { MockWebServer().use { server -> server.protocols = protocols; server.useHttps(serverTls.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    @Suppress("UNCHECKED_CAST")
    private fun operation(c: Case, store: PendingIntentStore, api: GameApi, token: SessionToken, guard: () -> Unit = {}): MoneyOp<Any> {
        val wire = object : OpTransport {
            override suspend fun get(path: String, query: Map<String, String>) = api.get(path, query, token)
            override suspend fun post(path: String, body: JsonObject): JsonObject = error("Observed command required")
            override suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit) =
                api.postMoneyCommand(intent.path, intent.body, intent.expectedCurrency?.let(GameCurrency::valueOf), token, refusal, guard)
        }
        val transport = when (c.spec) {
            is GemsSpec -> c.spec.verifiedTransport(wire)
            HeroUpgradeSpec, HeroRecoverySpec -> HeroCurrencyTransport(wire) { intent, refusal -> wire.postObserved(intent, refusal) }
            else -> wire
        }
        return MoneyOp(c.spec as MoneyOpSpec<Any>, store, transport)
    }
    private fun boundary(c: Case, status: Int = c.status, body: String = failure(c.code), attempted: Boolean = false,
                         terminal: Boolean = true, stale: Boolean = true) {
        lateinit var jar: SessionCookieJar
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (stale) jar.beginAuthentication() } } }) { server, client ->
            val cookies = Disk(); jar = SessionCookieJar(server.url("/"), cookies); val token = jar.sessionToken()
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            val disk = Disk(); val store = PendingIntentStore(disk)
            val other = c.intent.copy(wallet = "other-wallet", idempotencyKey = "other-key")
            assertTrue(store.create(other)); if (attempted) store.create(c.intent.copy(attempted = true))
            server.enqueue(MockResponse().setResponseCode(status).setBody(body).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            val op = operation(c, store, api, token); var hydrated = false
            assertThrows(Exception::class.java) { runBlocking { if (attempted) op.retry(wallet) { hydrated = true } else op.submit(c.intent) { hydrated = true } } }
            val reopened = PendingIntentStore(disk)
            assertEquals(c.code, if (terminal) null else c.intent.nextAttempt(), reopened.get(c.intent.kind, wallet))
            assertEquals(other, reopened.get(c.intent.kind, other.wallet)); assertFalse(hydrated)
            if (stale) assertNull(cookies.raw)
            // Other-wallet create + original create + attempted CAS + at most one terminal CAS.
            assertEquals(if (attempted) 3 else if (terminal) 4 else 3, disk.writes)
            assertEquals(1, server.requestCount); val sent = server.takeRequest()
            assertEquals("POST", sent.method); assertEquals(c.intent.body.toString(), sent.body.readUtf8())
            assertEquals(c.intent.expectedCurrency, sent.getHeader("x-pkw-expected-currency")); assertNull(sent.getHeader("x-pkw-currency"))
        }
    }
    @Test fun `late first refusals retire only the original wallet for all six commands`() { cases().forEach { boundary(it) } }
    @Test fun `observer and ordinary catch cannot double write a current refusal`() { cases().forEach { boundary(it, stale = false) } }
    @Test fun `generic malformed conflicting and wrong-status failures stay recoverable`() {
        cases().forEach { c ->
            boundary(c, body = "{}", terminal = false)
            boundary(c, body = """{"error":{"code":7,"message":"bad"}}""", terminal = false)
            boundary(c, body = failure("IDEMPOTENCY_BODY_MISMATCH"), terminal = false)
            boundary(c, status = 400, terminal = false)
            boundary(c, body = """{"code":"${c.code}","message":"Malformed envelope"}""", terminal = false, stale = false)
            boundary(c, body = """{"error":{"code":"${c.code}"}}""", terminal = false, stale = false)
        }
    }
    @Test fun `currency and operation mismatches cannot retire another consent`() {
        val hero = cases().first()
        boundary(hero, body = failure("CURRENCY_CONSENT_CHANGED", "KEEP"), terminal = false)
        boundary(hero, body = failure("CURRENCY_CONSENT_CHANGED", "GEMS"))
        boundary(hero, body = failure("HERO_NOT_RECOVERING"), terminal = false)
        boundary(cases()[2], body = failure("INSUFFICIENT_GEMS"), terminal = false)
        val recruitment = cases().last()
        boundary(recruitment, status = 409, body = failure("HERO_CONTRACT_UNAVAILABLE"), terminal = false)
        boundary(recruitment, status = 409, body = failure("HERO_RECRUIT_PRICE_CHANGED"))
    }
    @Test fun `later retry refusal never disproves an ambiguous original acceptance`() { cases().forEach { boundary(it, attempted = true, terminal = false) } }
    @Test fun `typed receipt GET errors after successful POST remain uncertain`() {
        cases().filter { it.spec is GemsSpec || it.intent.expectedCurrency != null }.forEach { c -> tls { server, client ->
            val jar = SessionCookieJar(server.url("/"), Disk()); val store = PendingIntentStore(Disk())
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            server.enqueue(MockResponse().setBody("{}")); server.enqueue(MockResponse().setResponseCode(c.status).setBody(failure(c.code)))
            assertThrows(IOException::class.java) { runBlocking { operation(c, store, api, jar.sessionToken()).submit(c.intent) {} } }
            assertEquals(c.intent.nextAttempt(), store.get(c.intent.kind, wallet)); assertEquals(2, server.requestCount)
            assertEquals("POST", server.takeRequest().method); assertEquals("GET", server.takeRequest().method)
        } }
    }
    @Test fun `actual enqueue still rejects obsolete reviews and observer cannot target cookie routes`() {
        var current = true
        tls(EventListener.Factory { current = false; object : EventListener() {} }) { server, client ->
            val jar = SessionCookieJar(server.url("/"), Disk()); val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            val c = cases().first(); val store = PendingIntentStore(Disk())
            assertThrows(IllegalStateException::class.java) { runBlocking { operation(c, store, api, jar.sessionToken()) { check(current) }.submit(c.intent) {} } }
            assertEquals(c.intent.nextAttempt(), store.get(c.intent.kind, wallet))
            for (path in listOf("/auth/logout", "/auth/verify", "/base/buildings")) assertThrows(IllegalArgumentException::class.java) {
                runBlocking { api.postMoneyCommand(path, buildJsonObject {}, null, jar.sessionToken(), {}, {}) }
            }
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun `cancelled caller cannot finish ahead of synchronous original durable refusal write`() {
        tls { server, client -> runBlocking {
            val c = cases()[2]; val jar = SessionCookieJar(server.url("/"), Disk()); val disk = Disk(); val store = PendingIntentStore(disk)
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            disk.beforeWrite = { if (disk.writes == 2) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) } }
            server.enqueue(MockResponse().setResponseCode(c.status).setBody(failure(c.code)))
            var finished = false
            val job = launch(Dispatchers.Default) { try { operation(c, store, api, jar.sessionToken()).submit(c.intent) {} } finally { finished = true } }
            assertTrue(entered.await(5, TimeUnit.SECONDS)); job.cancel(); delay(30); assertFalse(finished)
            release.countDown(); job.join(); assertNull(PendingIntentStore(disk).get(c.intent.kind, wallet)); assertEquals(1, server.requestCount)
        } }
    }
    @Test fun `cancellation after complete HTTP body still preserves original refusal before caller completes`() {
        for (protocol in listOf(Protocol.HTTP_1_1, Protocol.HTTP_2)) {
        lateinit var job: Job
        var receivedProtocol: Protocol? = null
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        tls(EventListener.Factory { object : EventListener() {
            override fun responseHeadersEnd(call: Call, response: Response) { receivedProtocol = response.protocol }
            override fun responseBodyEnd(call: Call, byteCount: Long) {
            job.cancel(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
        } } }, protocols = if (protocol == Protocol.HTTP_1_1) listOf(protocol) else listOf(protocol, Protocol.HTTP_1_1)) { server, client -> runBlocking {
            val c = cases()[2]; val jar = SessionCookieJar(server.url("/"), Disk()); val disk = Disk(); val store = PendingIntentStore(disk)
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            server.enqueue(MockResponse().setResponseCode(c.status).setBody(failure(c.code)))
            job = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { operation(c, store, api, jar.sessionToken()).submit(c.intent) {} }
            job.start()
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                // The event fires before body.string returns. Cancellation may not finish the
                // operation or destroy its store until the original response can be decoded.
                assertFalse(job.isCompleted); assertNotNull(store.get(c.intent.kind, wallet))
            } finally { release.countDown() }
            withTimeout(5_000) { job.join() }
            assertNull(PendingIntentStore(disk).get(c.intent.kind, wallet)); assertEquals(1, server.requestCount); assertEquals(protocol, receivedProtocol)
        } }
        }
    }
    @Test fun `cancelled partial observed body drains strict refusal before obsolete session and store lifetime end`() {
        for (malformed in listOf(false, true)) {
            lateinit var job: Job; lateinit var jar: SessionCookieJar
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val socketCancelled = java.util.concurrent.atomic.AtomicBoolean()
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                jar.beginAuthentication(); job.cancel(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
                socketCancelled.set(call.isCanceled())
            } } }) { server, client -> runBlocking {
                val c = cases()[2]; val cookies = Disk(); jar = SessionCookieJar(server.url("/"), cookies)
                val token = jar.sessionToken(); val store = PendingIntentStore(Disk()); val other = c.intent.copy(wallet = "other-wallet")
                assertTrue(store.create(other)); val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
                server.enqueue(MockResponse().setResponseCode(c.status).setBody(if (malformed) "{bad incomplete response}" else failure(c.code))
                    .throttleBody(8, 25, TimeUnit.MILLISECONDS).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
                job = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { operation(c, store, api, token).submit(c.intent) {} }
                job.start()
                try { assertTrue(entered.await(5, TimeUnit.SECONDS)); assertFalse(job.isCompleted); assertNotNull(store.get(c.intent.kind, wallet)) }
                finally { release.countDown() }
                withTimeout(5_000) { job.join() }
                assertFalse("An owned money response must drain instead of cancelling its socket", socketCancelled.get())
                assertEquals(if (malformed) c.intent.nextAttempt() else null, store.get(c.intent.kind, wallet))
                assertEquals(other, store.get(c.intent.kind, other.wallet)); assertNull(cookies.raw); assertEquals(1, server.requestCount)
            } }
        }
    }
    @Test fun `cancellation before headers or actual enqueue never starts an evidence drain`() {
        tls { server, client -> runBlocking {
            val c = cases()[2]; val jar = SessionCookieJar(server.url("/"), Disk()); val store = PendingIntentStore(Disk())
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            server.enqueue(MockResponse().setHeadersDelay(2, TimeUnit.SECONDS).setResponseCode(c.status).setBody(failure(c.code)))
            val job = launch(Dispatchers.Default) { operation(c, store, api, jar.sessionToken()).submit(c.intent) {} }
            assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)); job.cancel(); withTimeout(1_000) { job.join() }
            assertEquals(c.intent.nextAttempt(), store.get(c.intent.kind, wallet)); assertEquals(1, server.requestCount)
        } }
        lateinit var job: Job
        tls(EventListener.Factory { job.cancel(); object : EventListener() {} }) { server, client -> runBlocking {
            val c = cases()[2]; val jar = SessionCookieJar(server.url("/"), Disk()); val store = PendingIntentStore(Disk())
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            job = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { operation(c, store, api, jar.sessionToken()).submit(c.intent) {} }
            job.start(); withTimeout(1_000) { job.join() }
            assertEquals(0, server.requestCount); assertEquals(c.intent.nextAttempt(), store.get(c.intent.kind, wallet))
        } }
    }
    @Test fun `an observed drain retains read timeout and leaves incomplete refusal uncertain`() {
        lateinit var job: Job
        val bodyStarted = java.util.concurrent.atomic.AtomicBoolean()
        val enteredBody = CompletableDeferred<Unit>()
        val readFailure = java.util.concurrent.atomic.AtomicReference<IOException?>()
        tls(EventListener.Factory { object : EventListener() {
            override fun responseFailed(call: Call, ioe: IOException) { readFailure.set(ioe) }
        } }) { server, client -> runBlocking {
            val c = cases()[2]; val jar = SessionCookieJar(server.url("/"), Disk()); val store = PendingIntentStore(Disk())
            // Keep the normal header timeout. The first actual source read occurs inside
            // GameApi's owned onResponse callback, before OkHttp's later body-start event.
            // Arm the real socket/stream timeout here, never inject a simulated exception.
            val bounded = client.newBuilder().addInterceptor { chain ->
                val response = chain.proceed(chain.request()); val body = requireNotNull(response.body)
                val source = object : okio.ForwardingSource(body.source()) {
                    override fun read(sink: okio.Buffer, byteCount: Long): Long {
                        if (bodyStarted.compareAndSet(false, true)) {
                            timeout().timeout(500, TimeUnit.MILLISECONDS)
                            enteredBody.complete(Unit); job.cancel()
                        }
                        return super.read(sink, byteCount)
                    }
                }.buffer()
                response.newBuilder().body(object : ResponseBody() {
                    override fun contentType() = body.contentType()
                    override fun contentLength() = body.contentLength()
                    override fun source() = source
                }).build()
            }.build()
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", bounded)
            server.enqueue(MockResponse().setResponseCode(c.status).setBody(failure(c.code))
                .setHeadersDelay(750, TimeUnit.MILLISECONDS).setBodyDelay(2, TimeUnit.SECONDS))
            job = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { operation(c, store, api, jar.sessionToken()).submit(c.intent) {} }
            job.start(); withTimeout(10_000) { enteredBody.await() }
            withTimeout(3_000) { job.join() } // Preserve the bounded drain assertion after ownership.
            assertTrue("The timeout must occur after original response ownership", bodyStarted.get())
            assertTrue("An incomplete owned body must still time out", readFailure.get() is java.net.SocketTimeoutException)
            assertEquals(c.intent.nextAttempt(), store.get(c.intent.kind, wallet)); assertEquals(1, server.requestCount)
            val sent = server.takeRequest(); assertEquals("POST", sent.method); assertEquals(c.intent.body.toString(), sent.body.readUtf8())
        } }
    }
    @Test fun `ordinary GET and POST still cancel the socket during response consumption`() {
        for (method in listOf("GET", "POST")) {
            lateinit var job: Job
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                job.cancel(); assertTrue("Ordinary responses stay cancellable", call.isCanceled())
            } } }) { server, client -> runBlocking {
                val jar = SessionCookieJar(server.url("/"), Disk()); val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
                server.enqueue(MockResponse().setBody("{\"ok\":true}").throttleBody(1, 2, TimeUnit.SECONDS))
                job = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { if (method == "GET") api.get("/me") else api.post("/ordinary", buildJsonObject {}) }
                job.start(); withTimeout(3_000) { job.join() }; assertEquals(1, server.requestCount)
            } }
        }
    }

    @Test fun `late first refusal cannot erase same wallet retry accepted proof or uncertain dispatch`() {
        for (accepted in listOf(false, true)) {
            lateinit var jar: SessionCookieJar
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val bodies = java.util.concurrent.atomic.AtomicInteger()
            tls(EventListener.Factory { object : EventListener() {
                override fun responseBodyStart(call: Call) {
                    if (bodies.incrementAndGet() == 1) {
                        jar.beginAuthentication(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
                    }
                }
            } }) { server, client -> runBlocking {
                val c = cases()[2]; val disk = Disk(); val store = PendingIntentStore(disk)
                jar = SessionCookieJar(server.url("/"), Disk()); val originalSession = jar.sessionToken()
                val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
                server.enqueue(MockResponse().setResponseCode(c.status).setBody(failure(c.code)))
                val first = async(Dispatchers.Default) { runCatching { operation(c, store, api, originalSession).submit(c.intent) {} } }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                try {
                    assertEquals(1L, store.get(c.intent.kind, wallet)!!.attemptRevision)
                    if (accepted) {
                        server.enqueue(MockResponse().setBody("{}"))
                        server.enqueue(MockResponse().setBody("""{"wallet":"$wallet","idempotencyKey":"$key","status":"accepted","serverNow":"2026-09-21T12:00:00Z",
                            "receipt":{"version":1,"status":"accepted","wallet":"$wallet","receiptId":"$base","acceptedAt":"2026-09-21T12:00:00Z",
                            "request":${c.intent.body},"funding":{"currency":"KEEP","amount":"10"},"result":{"gems":"20","rate":2}}}"""))
                    } else server.enqueue(MockResponse().setResponseCode(500).setBody("{}"))
                    assertThrows(IOException::class.java) { runBlocking {
                        operation(c, store, api, jar.sessionToken()).retry(wallet) { throw IOException("Hold accepted proof until hydration") }
                    } }
                    val newer = store.get(c.intent.kind, wallet)!!
                    assertEquals(2L, newer.attemptRevision); assertEquals(accepted, newer.receipt != null)
                    release.countDown(); assertTrue(first.await().isFailure)
                    assertEquals("An older first refusal cannot erase a newer dispatch or receipt", newer, PendingIntentStore(disk).get(c.intent.kind, wallet))
                    assertEquals(if (accepted) 3 else 2, server.requestCount)
                    assertEquals(c.intent.body.toString(), server.takeRequest().body.readUtf8())
                    assertEquals(c.intent.body.toString(), server.takeRequest().body.readUtf8())
                } finally { release.countDown() }
            } }
        }
    }

    @Test fun `disk failure or competing proof cannot erase the original pending record`() {
        for (competing in listOf(false, true)) tls { server, client ->
            val c = cases()[2]; val disk = Disk(); val store = PendingIntentStore(disk)
            val jar = SessionCookieJar(server.url("/"), Disk()); var changed = false
            val instrumented = client.newBuilder().eventListener(object : EventListener() { override fun responseBodyStart(call: Call) {
                if (competing) { val saved = store.get(c.intent.kind, wallet)!!; store.replaceIfMatching(saved, saved.copy(receipt = buildJsonObject { put("proof", "competing") })); changed = true }
                else disk.beforeWrite = { throw IOException("disk unavailable") }
            } }).build()
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", instrumented)
            server.enqueue(MockResponse().setResponseCode(c.status).setBody(failure(c.code)))
            assertThrows(Exception::class.java) { runBlocking { operation(c, store, api, jar.sessionToken()).submit(c.intent) {} } }
            assertNotNull(store.get(c.intent.kind, wallet)); assertEquals(competing, changed); assertEquals(1, server.requestCount)
        }
    }
}
