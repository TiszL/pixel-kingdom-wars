package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PreparationTransportTimingTest {
    private val path = "/raids/11111111-1111-4111-8111-111111111111/presentation"
    private class Memory : SecretStore {
        private var value: String? = null
        override fun read() = value
        override fun write(value: String) { this.value = value }
        override fun clear() { value = null }
    }
    private class Fixture(listener: EventListener = EventListener.NONE) : AutoCloseable {
        private val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        private val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListener(listener).build()
        val api = GameApi(server.url("/").toString(), SessionCookieJar(server.url("/"), Memory()), "timing-test", transport)
        override fun close() { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }
    private fun observer(onStage: (BattlePreparationStage) -> Unit) = object : BattlePreparationTiming {
        override val ordinal = 1L
        override fun stage(stage: BattlePreparationStage) = onStage(stage)
        override fun assembled(revision: String) = Unit
        override fun finish(outcome: BattlePreparationOutcome) = Unit
    }
    @Test fun `actual response headers precede a gated body and JSON parsing without collecting response data`() = runBlocking {
        val bodyEntered = CompletableDeferred<Unit>(); val release = CountDownLatch(1)
        val stages = Collections.synchronizedList(mutableListOf<BattlePreparationStage>())
        Fixture(object : EventListener() {
            override fun responseBodyStart(call: Call) { bodyEntered.complete(Unit); check(release.await(5, TimeUnit.SECONDS)) }
        }).use { fixture ->
            fixture.server.enqueue(MockResponse().setBody("{\"ready\":true}"))
            val call = async { fixture.api.getPresentation(path, emptyMap(), fixture.api.sessionToken(), observer { stages += it }) }
            try {
                withTimeout(5000) { bodyEntered.await() }
                assertEquals(listOf(BattlePreparationStage.CALL_ENQUEUED, BattlePreparationStage.RESPONSE_HEADERS), stages.toList())
                assertFalse(call.isCompleted)
                release.countDown()
                assertTrue(call.await().flag("ready"))
                assertEquals(listOf(BattlePreparationStage.CALL_ENQUEUED, BattlePreparationStage.RESPONSE_HEADERS,
                    BattlePreparationStage.BODY_READ, BattlePreparationStage.JSON_PARSED), stages.toList())
                assertEquals("GET", fixture.server.takeRequest().method)
            } finally { release.countDown(); call.cancelAndJoin() }
        }
    }
    @Test fun `throwing optional transport observer cannot change authenticated read result`() = runBlocking {
        Fixture().use { fixture ->
            fixture.server.enqueue(MockResponse().setBody("{\"ready\":true}"))
            val result = fixture.api.getPresentation(path, emptyMap(), fixture.api.sessionToken(), observer { throw AssertionError("diagnostic unavailable") })
            assertTrue(result.flag("ready")); assertEquals(1, fixture.server.requestCount)
        }
    }
}
