package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.starter.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Authenticated selected endpoint uses the existing guarded transport and never gains receipt authority. */
class PaidStarterSelectionHttpTest {
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private val base = "00000000-0000-4000-8000-000000000001"
    @Test fun `selected GET binds exact base realm session and rejects extra authority before enqueue`() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try { MockWebServer().use { server ->
            server.useHttps(tls.sslSocketFactory(), false); server.start()
            val jar = SessionCookieJar(server.url("/"), Memory()); val token = jar.sessionToken()
            val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
            fun get(query: Map<String, String>, guard: () -> Unit = {}, evidence: ((JsonObject) -> Unit)? = null) = runBlocking {
                api.getStarterExpedition("/starter-expeditions/paid-route", query, token, guard, evidence)
            }
            for (query in listOf(mapOf("baseId" to base), mapOf("realm" to "0"), mapOf("baseId" to base, "realm" to "00"),
                mapOf("baseId" to base, "realm" to "0", "wallet" to "other")))
                assertThrows(Exception::class.java) { get(query) }
            val query = mapOf("baseId" to base, "realm" to "0")
            assertThrows(Exception::class.java) { get(query, evidence = {}) }
            assertThrows(Exception::class.java) { get(query, guard = { error("view dismissed") }) }; assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setBody("{}")); get(query)
            val request = server.takeRequest(); assertEquals("GET", request.method)
            assertEquals("/api/starter-expeditions/paid-route?baseId=$base&realm=0", request.path)
            jar.beginAuthentication(); assertThrows(SessionSupersededException::class.java) { get(query) }
            assertEquals(1, server.requestCount)
        } } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
}
