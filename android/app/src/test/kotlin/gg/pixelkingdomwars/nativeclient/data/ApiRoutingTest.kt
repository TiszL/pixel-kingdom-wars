package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** The one classifier that turns coded failures into navigation, mirroring the web's `lib/api.ts`. */
class ApiRoutingTest {
    private fun error(status: Int, code: String? = null, retryAfter: Long? = null) = ApiException(status, code, "msg", retryAfterSeconds = retryAfter)

    @Test fun `status and code pairs map to the web's global routes`() {
        assertEquals(RoutingEvent.SessionExpired, ApiRouting.classify(error(401, "ANY")))
        assertEquals(RoutingEvent.LandRequired, ApiRouting.classify(error(402, "LAND_NOT_OWNED")))
        assertNull("A 402 without the land code is an ordinary failure", ApiRouting.classify(error(402, "OTHER")))
        assertEquals(RoutingEvent.AlphaGated, ApiRouting.classify(error(403, "ALPHA_GATED")))
        assertNull(ApiRouting.classify(error(403, "FORBIDDEN")))
        assertEquals(RoutingEvent.UpdateRequired("WORLD_UPDATE_REQUIRED", "msg"), ApiRouting.classify(error(426, "WORLD_UPDATE_REQUIRED")))
        assertEquals(RoutingEvent.BaseAuthority("BASE_CLIENT_UPGRADE_REQUIRED", "msg"), ApiRouting.classify(error(426, "BASE_CLIENT_UPGRADE_REQUIRED")))  // web throwResponseError: a base-selection 426 is an explicit-selection demand, never the stale-bundle gate
        assertEquals(RoutingEvent.UpdateRequired(null, "msg"), ApiRouting.classify(error(426)))
        assertEquals(RoutingEvent.Maintenance(30, "msg"), ApiRouting.classify(error(503, "MAINTENANCE", 30)))
        assertNull("A busy 503 is retried by its caller, not routed", ApiRouting.classify(error(503, "NATIVE_PRESENTATION_BUSY")))
    }
    @Test fun `insufficient funds of any currency opens the funds sheet`() {
        for (code in listOf("INSUFFICIENT_KEEP", "INSUFFICIENT_SHARDS", "INSUFFICIENT_SOL"))
            assertEquals(RoutingEvent.InsufficientFunds(code, "msg"), ApiRouting.classify(error(422, code)))
        assertNull(ApiRouting.classify(error(422, "TRAINING_QUOTE_CHANGED")))
    }
    @Test fun `contract failures route to the update gate and plain IO does not route`() {
        assertEquals(RoutingEvent.Incompatible("/army"), ApiRouting.classify(ApiCompatibilityException("/army")))
        assertNull(ApiRouting.classify(java.io.IOException("lost")))
        assertNull(ApiRouting.classify(IllegalStateException("bug")))
    }
    @Test fun `a session bound client reports the event and still throws to its caller`() = runBlocking {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try {
            val api = GameApi.withTransport(server.url("/").toString(), SessionCookieJar(server.url("/"), MemoryStore()), "routing-test", transport)
            val routing = ApiRouting()
            val events = async { routing.events.first() }
            server.enqueue(MockResponse().setResponseCode(402).setBody("""{"error":{"code":"LAND_NOT_OWNED","message":"Buy land"}}"""))
            val client = SessionApiClient(api, api.sessionToken(), routing)
            val error = runCatching { client.get("/forge") }.exceptionOrNull() as ApiException
            assertEquals(402, error.status)
            assertEquals(RoutingEvent.LandRequired, events.await())
            // A stale token never reaches the transport: the request is refused before any bytes leave.
            val stale = api.sessionToken(); api.beginAuthentication()
            assertThrows(SessionSupersededException::class.java) { runBlocking { SessionApiClient(api, stale, routing).get("/me") } }
            assertEquals(1, server.requestCount)
        } finally { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }

    @Test fun `base authority codes route to the deed selector and a transient verification failure only asks for a retry`() {
        // Web BASE_SELECTION_ERROR_CODES → recoverBaseAuthority; a 426 with the selection code is not a stale bundle.
        val changed = ApiRouting.classify(ApiException(409, "DEED_OWNERSHIP_CHANGED", "deed ownership changed")) as RoutingEvent.BaseAuthority
        assertEquals("DEED_OWNERSHIP_CHANGED", changed.code); assertFalse(changed.transient)
        assertTrue(ApiRouting.classify(ApiException(404, "BASE_NOT_OWNED", "base not owned")) is RoutingEvent.BaseAuthority)
        val explicit = ApiRouting.classify(ApiException(426, "BASE_CLIENT_UPGRADE_REQUIRED", "select a base")) as RoutingEvent.BaseAuthority
        assertEquals(RoutingEvent.BaseAuthority.BASE_CLIENT_UPGRADE_REQUIRED, explicit.code)
        assertTrue("Any other 426 is still the update gate", ApiRouting.classify(ApiException(426, "WORLD_UPDATE_REQUIRED", "update")) is RoutingEvent.UpdateRequired)
        val unavailable = ApiRouting.classify(ApiException(503, "DEED_AUTHORITY_UNAVAILABLE", "deed ownership unavailable or changed")) as RoutingEvent.BaseAuthority
        assertTrue(unavailable.transient)
        assertNull("A 423 raid lock is an ordinary refusal the screen shows in place", ApiRouting.classify(ApiException(423, "BASE_BEING_RAIDED", "raided")))
    }
}
