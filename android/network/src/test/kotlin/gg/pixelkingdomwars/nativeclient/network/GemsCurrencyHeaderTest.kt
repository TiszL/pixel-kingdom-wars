package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class GemsCurrencyHeaderTest {
    @Test fun `Gems preference belongs only to the explicitly reviewed POST and never leaks to legacy requests`() = runBlocking {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        MockWebServer().use { server ->
            server.useHttps(tls.sslSocketFactory(), false); server.start()
            val origin = server.url("/")
            val memory = object : SecretStore { override fun read(): String? = null; override fun write(value: String) {}; override fun clear() {} }
            val api = GameApi.withTransport(origin.toString(), SessionCookieJar(origin, memory), "test", transport)
            repeat(5) { server.enqueue(MockResponse().setBody("{}")) }
            val consent = GameCurrencyConsent.gemsFirst("10", Balances("0", "10", "0", features = BalanceFeatures(GemsFeature(1, 1))),
                GemsCapability(true, listOf("ledger-keep"), null, 1, 1, 1, 1000))
            api.postGameCurrency("/items/buy", buildJsonObject {}, consent)
            api.post("/items/buy", buildJsonObject {})
            api.get("/balances")
            api.postExactGameCurrency("/heroes/vex/upgrade", buildJsonObject {}, GameCurrency.GEMS)
            api.postExactGameCurrency("/heroes/vex/recovery/speedup", buildJsonObject {}, GameCurrency.KEEP)
            val explicit = server.takeRequest()
            assertEquals("POST", explicit.method); assertEquals("GEMS", explicit.getHeader("x-pkw-currency"))
            assertNull(explicit.getHeader("x-pkw-expected-currency"))
            assertEquals(GameCurrency.KEEP, consent.expected)
            repeat(2) { val legacy = server.takeRequest(); assertNull(legacy.getHeader("x-pkw-currency")); assertNull(legacy.getHeader("x-pkw-expected-currency")) }
            for (currency in listOf("GEMS", "KEEP")) {
                val exact = server.takeRequest(); assertEquals("POST", exact.method)
                assertEquals(currency, exact.getHeader("x-pkw-expected-currency")); assertNull(exact.getHeader("x-pkw-currency"))
            }
            val stale = api.sessionToken(); api.beginAuthentication()
            try { api.postGameCurrency("/items/buy", buildJsonObject {}, consent, stale); fail("Stale session sent") } catch (_: SessionSupersededException) {}
            try { api.postExactGameCurrency("/heroes/vex/upgrade", buildJsonObject {}, GameCurrency.GEMS, stale); fail("Stale session sent") } catch (_: SessionSupersededException) {}
            assertEquals(5, server.requestCount)
        }
        transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown()
    }
    @Test fun `exact consent is checked again after the IO hop immediately before the HTTP call is enqueued`() = runBlocking<Unit> {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val current = java.util.concurrent.atomic.AtomicBoolean(true)
        var guards = 0
        var built = 0
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
            .eventListenerFactory { // RealCall constructs its listener on Dispatchers.IO, before enqueue.
                built++; current.set(false); object : okhttp3.EventListener() {}
            }.build()
        MockWebServer().use { server ->
            server.useHttps(tls.sslSocketFactory(), false); server.start()
            val origin = server.url("/")
            val memory = object : SecretStore { override fun read(): String? = null; override fun write(value: String) {}; override fun clear() {} }
            val api = GameApi.withTransport(origin.toString(), SessionCookieJar(origin, memory), "test", transport)
            assertThrows(IllegalStateException::class.java) { runBlocking {
                api.postExactGameCurrency("/heroes/vex/upgrade", buildJsonObject {}, GameCurrency.GEMS,
                    requireCurrent = { guards++; check(current.get()) { "Review invalidated after IO admission" } })
            } }
            assertEquals("Guard must run both before dispatch and at the actual enqueue boundary", 2, guards)
            assertEquals("The IO call was prepared before the guard caught the change", 1, built)
            assertEquals("No paid request can escape an invalidated review", 0, server.requestCount)
            assertEquals(0, transport.dispatcher.queuedCallsCount())
        }
        transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown()
    }

}
