package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsBindingTest {
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private fun fixture(block: (MockWebServer, GameApi, SessionCookieJar, StarterIdentity, JsonObject) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build(); val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val http = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try { MockWebServer().use { server ->
            server.useHttps(tls.sslSocketFactory(), false); server.start()
            val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax/recovery.json")).readText()).jsonObject.getValue("combined").jsonObject
            val jar = SessionCookieJar(server.url("/"), Memory())
            jar.saveFromResponse(server.url("/"), listOf(Cookie.parse(server.url("/"), "session=original; Secure; HttpOnly; Path=/")!!))
            val game = GameApi.withTransport(server.url("/").toString(), jar, "binding-fixture", http)
            block(server, game, jar, StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", raw.getValue("wallet").jsonPrimitive.content), raw)
        } } finally { http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() }
    }
    @Test fun `bound tax port shares authentication cookies and loses admission with the same cookie generation`() = fixture { server, game, jar, identity, raw -> runBlocking {
        val token = game.sessionToken(); val port = game.miningTaxClaimsPort(identity, token); val tx = MiningTaxClaimsTransport(port) { false }
        port.requireCurrent(identity, token)
        server.enqueue(MockResponse().setBody(raw.toString()).addHeader("Set-Cookie", "session=rotated; Secure; HttpOnly; Path=/"))
        tx.saved(raw.getValue("idempotencyKey").jsonPrimitive.content, { port.requireCurrent(identity, token) }, {}) {}
        assertEquals("session=original", server.takeRequest().getHeader("Cookie")); assertEquals("rotated", jar.loadForRequest(server.url("/")).single().value)
        game.beginAuthentication(token)
        assertTrue(runCatching { port.requireCurrent(identity, token) }.isFailure)
        assertTrue(runCatching { game.miningTaxClaimsPort(identity, token) }.isFailure); assertEquals(1, server.requestCount)
    } }
    @Test fun `factory and bound port reject foreign origins identities and separately owned session tokens`() = fixture { server, game, _, identity, _ ->
        val token = game.sessionToken(); val port = game.miningTaxClaimsPort(identity, token)
        assertTrue(runCatching { game.miningTaxClaimsPort(identity.copy(origin = "https://other.test"), token) }.isFailure)
        assertTrue(runCatching { port.requireCurrent(identity.copy(cluster = "mainnet-beta"), token) }.isFailure)
        val foreign = SessionCookieJar(server.url("/"), Memory()).sessionToken()
        assertTrue(runCatching { port.requireCurrent(identity, foreign) }.isFailure)
        assertTrue(runCatching { game.miningTaxClaimsPort(identity, foreign) }.isFailure); assertEquals(0, server.requestCount)
    }
}
