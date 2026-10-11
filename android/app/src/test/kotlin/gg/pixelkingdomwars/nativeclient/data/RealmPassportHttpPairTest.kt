package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SessionCookieJar
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Replays root's unmodified authenticated API response bytes through the real
 * native HTTPS/session transport and repository. Backend source execution is
 * recorded by the companion API pair; starter ownership changes through the
 * recorded DB owner/slot transfer, not a full marketplace settlement. This is
 * not a live-chain/device test. */
class RealmPassportHttpPairTest {
    private fun pair(name: String): JsonObject {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/realm-passport-http-pair.json")) {
            "Actual API byte pair has not been supplied; never substitute synthetic data"
        }.use { it.readBytes() }.decodeToString()).jsonObject
        require(raw.getValue("source").jsonPrimitive.content.isNotBlank())
        return raw.getValue("pairs").jsonObject.getValue(name).jsonObject
    }
    private fun JsonObject.raw(name: String) = getValue("raw").jsonObject.getValue(name).jsonPrimitive.let {
        require(it.isString); it.content
    }
    private fun tls(block: suspend (MockWebServer, OkHttpClient) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try {
            MockWebServer().use { server ->
                server.useHttps(identity.sslSocketFactory(), false); server.start()
                runBlocking { withTimeout(20_000) { block(server, client) } }
            }
        } finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private fun repository(server: MockWebServer, client: OkHttpClient, wallet: String): RealmPassportRepository {
        val jar = SessionCookieJar(server.url("/"), MemoryStore())
        jar.saveFromResponse(server.url("/"), listOf(requireNotNull(Cookie.parse(server.url("/"), "session=passport-pair; Path=/; Secure; HttpOnly"))))
        val api = GameApi.withTransport(server.url("/").toString(), jar, "passport-pair", client)
        val session = AccountSession(wallet, server.url("/").toString(), jar.sessionToken())
        val holder = AccountSessionHolder(dispatcher = Dispatchers.Unconfined).also { it.replace(session) }
        return RealmPassportRepository(session, holder, SessionApiClient(api, session.token, ApiRouting()))
    }
    private fun respond(server: MockWebServer, bytes: String) {
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setHeader("Cache-Control", "private, no-store").setBody(bytes))
    }
    private fun request(server: MockWebServer, path: String) {
        val request = requireNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("GET", request.method); assertEquals(path, request.path)
        assertEquals("session=passport-pair", request.getHeader("Cookie"))
        assertEquals("android-native", request.getHeader("X-PKW-Client"))
        assertEquals(0L, request.bodySize)
    }
    @Test fun `actual starter returns retain original actor history after recorded deed transfer and use exclusive cursor`() = tls { server, client ->
        val source = pair("starter"); val wallet = source.getValue("wallet").jsonPrimitive.content
        val repo = repository(server, client, wallet)
        respond(server, source.raw("first")); repo.discover()
        assertTrue(repo.state.value.discoverable); assertNull(repo.state.value.expeditions.observation)
        request(server, "/api/realm-passport/expeditions?kind=starter")
        respond(server, source.raw("first")); repo.expeditions("starter")
        val first = requireNotNull(repo.state.value.expeditions.observation?.data)
        assertEquals(20, first.rows.size); assertEquals(first.rows.last().expeditionId, first.nextCursor)
        assertTrue(first.rows.all { it.kind == "starter" && it.routeVersion != null && it.policyVersion == null })
        request(server, "/api/realm-passport/expeditions?kind=starter")
        respond(server, source.raw("second")); repo.expeditions("starter", next = true)
        val second = requireNotNull(repo.state.value.expeditions.observation?.data)
        assertEquals(1, second.rows.size); assertNull(second.nextCursor)
        assertTrue(second.rows.single().expeditionId > requireNotNull(first.nextCursor))
        assertEquals(first.rows.first().originalBaseId, second.rows.single().originalBaseId)
        request(server, "/api/realm-passport/expeditions?kind=starter&cursor=${first.nextCursor}")
        assertEquals(3, server.requestCount)
    }
    @Test fun `actual advanced return uses original advanced policy with no invented route catalogue version`() = tls { server, client ->
        val source = pair("advanced"); val repo = repository(server, client, source.getValue("wallet").jsonPrimitive.content)
        respond(server, source.raw("first")); repo.expeditions("advanced")
        val page = requireNotNull(repo.state.value.expeditions.observation?.data)
        assertEquals(1, page.rows.size); assertNull(page.nextCursor)
        val row = page.rows.single(); assertEquals("advanced", row.kind); assertEquals(1, row.policyVersion); assertNull(row.routeVersion)
        request(server, "/api/realm-passport/expeditions?kind=advanced"); assertEquals(1, server.requestCount)
    }
    @Test fun `actual funded inclusions preserve cumulative publication and attestation distinction through source outage`() = tls { server, client ->
        val source = pair("mining"); val wallet = source.getValue("wallet").jsonPrimitive.content
        val repo = repository(server, client, wallet)
        respond(server, source.raw("history")); repo.inclusions()
        val history = requireNotNull(repo.state.value.inclusions.observation)
        assertEquals(2, history.data!!.rows.size); assertNull(history.data.nextCursor)
        assertEquals(listOf("1", "2"), history.data.rows.map { it.sequence })
        assertTrue(history.data.rows.all { it.leaf.wallet == wallet && it.leaf.sequence == it.sequence })
        request(server, "/api/realm-passport/mining/inclusions")
        respond(server, source.raw("current")); repo.current()
        val current = requireNotNull(repo.state.value.current.observation?.data)
        assertEquals("2", current.publicationSequence); assertEquals(PassportPublished("2", "2"), current.published)
        assertEquals(PassportAttested("1", "1", "1"), current.attested)
        request(server, "/api/realm-passport/mining/current")
        respond(server, source.raw("unavailable")); repo.current()
        val unavailable = requireNotNull(repo.state.value.current.observation)
        assertNull(unavailable.data); assertNotNull(unavailable.unavailableReason)
        assertEquals(history, repo.state.value.inclusions.observation)
        request(server, "/api/realm-passport/mining/current"); assertEquals(3, server.requestCount)
        repo.dismiss(); assertEquals(RealmPassportState(), repo.state.value)
    }
}
