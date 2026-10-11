package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** WHY: the API decides which ground revision a base or raid names from `X-PKW-Renderer-Contract`
 * (apps/api/src/native/clientPresentation.ts, docs/REALM-KIT-PLAN.md E-12). A native request without
 * it is read as a contract-14-or-older renderer and every revision-5 realm-kit context is rewritten to
 * revision 4, so a contract-15 APK that forgets the header silently paints the old r4 painting. The
 * header must ride EVERY request the app makes (JSON, uploads, images and the raid-events stream share
 * one interceptor) and must name the pack the app has loaded right now, not a value frozen at start-up. */
class GameApiRendererContractTest {
    private class Store : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private class Fixture(build: (Fixture, OkHttpClient) -> GameApi) : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val origin = server.url("/")
        val jar = SessionCookieJar(origin, Store())
        private val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val api = build(this, transport)
        init { jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "shardkeep_session=abc; Secure; HttpOnly; Path=/; Max-Age=3600")!!)) }
        override fun close() { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }
    private fun fixture(rendererContract: () -> Int?, simVersion: () -> Int? = { 17 }) = Fixture { f, transport ->
        GameApi.withTransport(f.origin.toString(), f.jar, "renderer-contract-test", transport, rendererContract, simVersion)
    }
    private fun json() = MockResponse().setHeader("Content-Type", "application/json").setBody("{}")

    @Test fun `every request declares the loaded pack's renderer contract beside the client and SIM headers`() = fixture({ 15 }).use { f ->
        repeat(3) { f.server.enqueue(json()) }
        f.server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").setBody("img"))
        runBlocking {
            f.api.get("/army"); f.api.post("/raids", jsonBody("baseId" to "b"))
            f.api.upload("/avatar", "POST", byteArrayOf(1), "image/png", f.api.sessionToken())
            f.api.download("/avatars/a.webp", "image/webp", 3, f.api.sessionToken())
        }
        repeat(4) {
            val request = f.server.takeRequest()
            assertEquals(request.path, "android-native", request.getHeader("X-PKW-Client"))
            assertEquals(request.path, "17", request.getHeader("x-sim-version"))
            assertEquals(request.path, "15", request.getHeader("X-PKW-Renderer-Contract"))
        }
    }

    @Test fun `the raid-events stream carries the same contract declaration`() = fixture({ 15 }).use { f ->
        f.server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": heartbeat\n\n"))
        runBlocking { runCatching { f.api.raidEvents("/bases/b86b557b-bb8f-488b-8b18-035600ba0e4a/raid-events", "b86b557b-bb8f-488b-8b18-035600ba0e4a").first() } }
        assertEquals("15", f.server.takeRequest().getHeader("X-PKW-Renderer-Contract"))
    }

    @Test fun `no loaded contract omits the header so the API keeps the revision-4 floor`() = fixture({ null }).use { f ->
        f.server.enqueue(json())
        runBlocking { f.api.get("/army") }
        val request = f.server.takeRequest()
        assertEquals("android-native", request.getHeader("X-PKW-Client"))
        assertNull(request.getHeader("X-PKW-Renderer-Contract"))
    }

    @Test fun `a content update raises the declared contract on the next request without a new client`() {
        var loaded: Int? = 14
        fixture({ loaded }).use { f ->
            repeat(2) { f.server.enqueue(json()) }
            runBlocking { f.api.get("/army") }
            assertEquals("14", f.server.takeRequest().getHeader("X-PKW-Renderer-Contract"))
            loaded = 15
            runBlocking { f.api.get("/army") }
            assertEquals("15", f.server.takeRequest().getHeader("X-PKW-Renderer-Contract"))
        }
    }

    /** The SIM lambda stays the LAST parameter: the harness and proof call sites written as
     * `GameApi(origin, jar, release) { sim }` must keep naming the SIM, never the renderer contract. */
    @Test fun `a trailing lambda still names the SIM version and never the renderer contract`() {
        Fixture { f, transport -> GameApi.withTransport(f.origin.toString(), f.jar, "trailing-lambda-test", transport) { 17 } }.use { f ->
            f.server.enqueue(json())
            runBlocking { f.api.get("/army") }
            val request = f.server.takeRequest()
            assertEquals("17", request.getHeader("x-sim-version"))
            assertNull(request.getHeader("X-PKW-Renderer-Contract"))
        }
    }
}
