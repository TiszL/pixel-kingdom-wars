package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ResearchSpeedupTransportTest {
    private class Disk : SecretStore {
        var raw: String? = null; var writes = 0
        override fun read() = raw
        override fun write(value: String) { raw = value; writes++ }
        override fun clear() { raw = null; writes++ }
    }
    private val terms = researchTerms()
    private val intent = ResearchSpec.intent(RESEARCH_WALLET, terms)
    private fun failure(code: String, currency: String? = null) = buildJsonObject { put("error", buildJsonObject {
        put("code", code); put("message", "Original refusal"); currency?.let { put("expectedCurrency", it) }
    }) }.toString()
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, block: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { server -> server.useHttps(serverTls.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private fun operation(store: PendingIntentStore, api: GameApi, token: SessionToken, guard: () -> Unit = {}): MoneyOp<ResearchAcceptance> {
        val reads = object : OpTransport {
            override suspend fun get(path: String, query: Map<String, String>) = api.get(path, query, token)
            override suspend fun post(path: String, body: JsonObject) = api.post(path, body, token)
        }
        return MoneyOp(ResearchSpec, store, ResearchCurrencyTransport(reads) { sent, refusal ->
            api.postMoneyCommand(sent.path, sent.body, GameCurrency.valueOf(requireNotNull(sent.expectedCurrency)), token, refusal, guard)
        })
    }
    private fun refusal(status: Int = 409, body: String = failure("RESEARCH_CONSENT_STALE"), retry: Boolean = false, clears: Boolean = true, stale: Boolean = true) {
        lateinit var jar: SessionCookieJar
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (stale) jar.beginAuthentication() } } }) { server, client ->
            val cookies = Disk(); jar = SessionCookieJar(server.url("/"), cookies); val token = jar.sessionToken()
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            val disk = Disk(); val store = PendingIntentStore(disk); val other = intent.copy(wallet = "22222222222222222222222222222222")
            assertTrue(store.create(other)); if (retry) assertTrue(store.create(intent.nextAttempt()))
            server.enqueue(MockResponse().setResponseCode(status).setBody(body).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            var hydrated = false
            assertThrows(Exception::class.java) { runBlocking {
                val op = operation(store, api, token)
                if (retry) op.retry(RESEARCH_WALLET) { hydrated = true } else op.submit(intent) { hydrated = true }
            } }
            val saved = PendingIntentStore(disk).get(IntentKind.RESEARCH, RESEARCH_WALLET)
            assertEquals(if (clears) null else if (retry) intent.nextAttempt().nextAttempt() else intent.nextAttempt(), saved)
            assertEquals(other, store.get(IntentKind.RESEARCH, other.wallet)); assertFalse(hydrated)
            assertEquals(if (retry || !clears) 3 else 4, disk.writes); if (stale) assertNull(cookies.raw)
            assertEquals(1, server.requestCount); val sent = server.takeRequest()
            assertEquals("POST", sent.method); assertEquals(terms.body.toString(), sent.body.readUtf8()); assertEquals("GEMS", sent.getHeader("x-pkw-expected-currency"))
        }
    }
    @Test fun `original typed refusal survives session replacement without double clear or other wallet writes`() {
        refusal(); refusal(stale = false)
        for ((status, code) in listOf(409 to "RESEARCH_PRICE_CHANGED", 409 to "TROOP_ROSTER_INACTIVE", 409 to "BASE_ID_REQUIRED",
            409 to "DEED_OWNERSHIP_CHANGED", 404 to "BASE_NOT_OWNED", 423 to "BASE_BEING_RAIDED", 503 to "DEED_AUTHORITY_UNAVAILABLE")) refusal(status, failure(code))
    }
    @Test fun `generic malformed collision wrong currency and later retry remain uncertain`() {
        for (body in listOf("{}", """{"error":{"code":7,"message":"bad"}}""", """{"error":{"code":"RESEARCH_CONSENT_STALE"}}""",
            failure("RESEARCH_RECEIPT_INVALID"), failure("IDEMPOTENCY_BODY_MISMATCH"), failure("CURRENCY_CONSENT_CHANGED", "KEEP"))) refusal(body = body, clears = false)
        refusal(status = 400, clears = false); refusal(body = failure("CURRENCY_CONSENT_CHANGED", "GEMS"))
        refusal(retry = true, clears = false)
    }
    @Test fun `POST success plus GET401 or unknown never disproves original charge`() {
        for (reply in listOf(MockResponse().setResponseCode(401).setBody(failure("RESEARCH_CONSENT_STALE")),
            MockResponse().setBody("""{"version":1,"status":"unknown","idempotencyKey":"research-original-key"}"""))) tls { server, client ->
            val jar = SessionCookieJar(server.url("/"), Disk()); val store = PendingIntentStore(Disk())
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            server.enqueue(MockResponse().setBody("{}")); server.enqueue(reply)
            assertThrows(IOException::class.java) { runBlocking { operation(store, api, jar.sessionToken()).submit(intent) {} } }
            assertEquals(intent.nextAttempt(), store.get(IntentKind.RESEARCH, RESEARCH_WALLET)); assertEquals(2, server.requestCount)
            assertEquals("POST", server.takeRequest().method); val get = server.takeRequest()
            assertEquals("GET", get.method); assertEquals("/api" + ResearchSpeedup.RECEIPT, get.requestUrl!!.encodedPath)
            terms.query.forEach { (key, value) -> assertEquals(value, get.requestUrl!!.queryParameter(key)) }
            assertNull(get.getHeader("x-pkw-expected-currency"))
        }
    }
    @Test fun `actual enqueue rejects stale command and legacy start cancel remain ordinary headerless`() {
        var current = true
        tls(EventListener.Factory { current = false; object : EventListener() {} }) { server, client ->
            val jar = SessionCookieJar(server.url("/"), Disk()); val store = PendingIntentStore(Disk())
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            assertThrows(IllegalStateException::class.java) { runBlocking { operation(store, api, jar.sessionToken()) { check(current) }.submit(intent) {} } }
            assertEquals(0, server.requestCount); assertEquals(intent.nextAttempt(), store.get(IntentKind.RESEARCH, RESEARCH_WALLET))
        }
        tls { server, client -> runBlocking {
            val jar = SessionCookieJar(server.url("/"), Disk()); val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            for (action in listOf("start", "cancel")) {
                val body = buildJsonObject { put("troop", terms.troop); put("idempotencyKey", "legacy-$action-key") }
                val old = PendingIntent(IntentKind.RESEARCH, RESEARCH_WALLET, null, "legacy-$action-key", "/army/research/$action", body, action,
                    buildJsonObject { put("action", action); put("troop", terms.troop) })
                server.enqueue(MockResponse().setBody("{}")); operation(PendingIntentStore(Disk()), api, jar.sessionToken()).submit(old) {}
                val sent = server.takeRequest(); assertNull(sent.getHeader("x-pkw-expected-currency")); assertEquals(body.toString(), sent.body.readUtf8())
            }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { api.postMoneyCommand("/army/research/start", terms.body, GameCurrency.GEMS, jar.sessionToken(), {}, {}) } }
            assertEquals(2, server.requestCount)
        } }
    }
    @Test fun `delayed first refusal cannot retire a newer same wallet attempt across sessions`() {
        lateinit var jar: SessionCookieJar
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val bodies = AtomicInteger()
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
            if (bodies.incrementAndGet() == 1) { jar.beginAuthentication(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        } } }) { server, client -> runBlocking {
            jar = SessionCookieJar(server.url("/"), Disk()); val disk = Disk(); val store = PendingIntentStore(disk)
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client); val oldToken = jar.sessionToken()
            server.enqueue(MockResponse().setResponseCode(409).setBody(failure("RESEARCH_CONSENT_STALE")))
            server.enqueue(MockResponse().setResponseCode(503).setBody(failure("UNAVAILABLE")))
            val first = launch(Dispatchers.Default) { runCatching { operation(store, api, oldToken).submit(intent) {} } }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertThrows(Exception::class.java) { runBlocking { operation(store, api, jar.sessionToken()).retry(RESEARCH_WALLET) {} } }
            release.countDown(); first.join()
            assertEquals(intent.nextAttempt().nextAttempt(), PendingIntentStore(disk).get(IntentKind.RESEARCH, RESEARCH_WALLET)); assertEquals(2, server.requestCount)
        } }
    }
}
