package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.session.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class RealmSalesTransportBindingTest {
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private fun tls(block: suspend (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(cert).build(); val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        try { MockWebServer().use { server -> server.useHttps(identity.sslSocketFactory(), false); server.start(); runBlocking { block(server, client) } } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private class Fixture(server: MockWebServer, client: OkHttpClient) {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/realm-sale-repository-fixture.json")).readText()).jsonObject
        val policy = RealmSalesSavedPolicy.from(raw.getValue("policy").jsonObject)
        val preparation = RealmSalePreparation.from(raw.getValue("preparation").jsonObject, policy.protocol)
        val cookies = Memory(); val jar = SessionCookieJar(server.url("/"), cookies)
        val game = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
        val session = AccountSession(preparation.wallet, server.url("/").toString(), jar.sessionToken())
        val holder = AccountSessionHolder(dispatcher = Dispatchers.Unconfined).also { it.replace(session) }
        val identity = StarterIdentity(session.origin.trimEnd('/'), "devnet", session.wallet)
        val api = SessionApiClient(game, session.token, ApiRouting())
        val binding = RealmSalesTransportBinding(identity, session, holder, api)
        val transport = RealmSalesTransport(binding); val storeDisk = Memory(); val store = RealmSalesStore(storeDisk, identity)
        val key get() = preparation.idempotencyKey
        val request get() = RealmSalePrepareRequest(key, preparation.spot, preparation.realm)
        val ports = object : RealmSalesPorts {
            override val transport = this@Fixture.transport
            override fun capture(newAction: Boolean): () -> Unit { check(!newAction); return { holder.requireCurrent(session) } }
            override fun policy(): RealmSalesSavedPolicy? = null
            override fun trust(): RealmSaleSigningTrust? = null
            override fun key(): String = error("Recovery never creates a new key")
            override fun clockMs(): Long = error("Recovery never requires a live clock")
            override suspend fun live(preparation: RealmSalePreparation, guard: () -> Unit) = error("Recovery never needs RPC")
            override suspend fun readyToSign(guard: () -> Unit) = error("Recovery never needs a wallet")
            override suspend fun sign(prepared: PreparedRealmSale, guard: () -> Unit, retain: suspend (SignedRealmSale) -> Unit) = error("Recovery never signs")
        }
        suspend fun seed() {
            store.begin(store.read(), request, policy); store.prepareAttempt(store.read()); store.acceptPreparation(key, preparation)
            store.signingAttempt(store.read())
            val wire = RealmSaleSignedWire.from(raw.getValue("wire").jsonObject)
            store.acceptSigned(key, Base64.getEncoder().encodeToString(wire.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()))
        }
        fun prep() = buildJsonObject { put("wallet", session.wallet); put("idempotencyKey", key); put("preparation", raw.getValue("preparation")) }
        fun saved(foreign: Boolean) = buildJsonObject {
            put("wallet", if (foreign) preparation.terms.seller else session.wallet); put("idempotencyKey", key)
            put("preparation", raw.getValue("preparation")); put("wire", JsonPrimitive("malformed adjacent wire")); put("settlement", raw.getValue("settlement"))
        }
    }
    @Test fun `cancelled stale prepare refusal drains into original encrypted store before its owner exits`() = tls { server, client -> coroutineScope {
        val f = Fixture(server, client); f.store.begin(f.store.read(), f.request, f.policy); f.store.prepareAttempt(f.store.read())
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var finished = false
        server.enqueue(MockResponse().setResponseCode(422).setBody("{\"error\":{\"code\":\"INSUFFICIENT_SOL\",\"message\":\"Declined\"}}")
            .addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
        val job = launch { try {
            f.transport.preparation(f.request, f.policy.protocol, true, {}, refusal = {
                entered.complete(Unit); release.await(); f.store.acceptPrepareRefusal(f.key, it)
            }) { fail("A refusal cannot create a quote") }
        } finally { finished = true } }
        withTimeout(3000) { entered.await() }; f.holder.replace(AccountSession(f.session.wallet, f.session.origin, f.session.token)); job.cancel(); yield()
        assertFalse(finished); assertNull(f.store.read().operation!!.prepareRefusal)
        release.complete(Unit); withTimeout(3000) { job.join() }
        val op = RealmSalesStore(f.storeDisk, f.identity).read().operation!!
        assertEquals(RealmSalePrepareRefusal(422, "INSUFFICIENT_SOL"), op.prepareRefusal); assertNull(op.preparation); assertFalse(op.signingStarted)
        assertNull(f.cookies.value); assertEquals(1, server.requestCount); assertEquals("POST", server.takeRequest().method)
    } }
    @Test fun `real authenticated recovery holds positive settlement before malformed nested wire but rejects a foreign actor`() {
        for (foreign in listOf(false, true)) tls { server, client ->
            val f = Fixture(server, client); f.seed(); val repo = RealmSalesRepository(f.store, f.ports)
            server.enqueue(MockResponse().setBody(f.prep().toString())); server.enqueue(MockResponse().setBody(f.saved(foreign).toString()))
            assertTrue(runCatching { repo.open() }.isFailure)
            assertEquals(!foreign, f.store.read().settlementHeld); assertNull(f.store.read().operation!!.settlement)
            assertEquals(2, server.requestCount); repeat(2) { assertEquals("GET", server.takeRequest().method) }
        }
    }
    @Test fun `same wallet lifecycle replacement during suspended retention keeps evidence before rejecting cookies`() = tls { server, client -> coroutineScope {
        val f = Fixture(server, client); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var retained = false
        server.enqueue(MockResponse().setBody(f.prep().toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
        val job = async { runCatching { f.binding.request("GET", "/seeker/realm-sales/prepare/by-key/${f.key}", null, {}) {
            entered.complete(Unit); release.await(); retained = true
        } } }
        withTimeout(3000) { entered.await() }
        f.holder.replace(AccountSession(f.session.wallet, f.session.origin, f.session.token)); release.complete(Unit)
        assertTrue(withTimeout(3000) { job.await() }.isFailure); assertTrue(retained); assertNull(f.cookies.value)
    } }
    @Test fun `identity mismatch and missing scoped capability fail closed without generic requests`() = tls { server, client ->
        val f = Fixture(server, client)
        assertThrows(IllegalArgumentException::class.java) { RealmSalesTransportBinding(f.identity.copy(wallet = f.preparation.terms.seller), f.session, f.holder, f.api) }
        assertThrows(IllegalArgumentException::class.java) { RealmSalesTransportBinding(f.identity.copy(origin = "https://elsewhere.test"), f.session, f.holder, f.api) }
        val binding = RealmSalesTransportBinding(f.identity, f.session, f.holder, FakeApiClient())
        assertTrue(runCatching { binding.request("GET", "/seeker/realm-sales/by-key/${f.key}", null, {}) {} }.exceptionOrNull() is UnsupportedOperationException)
        assertEquals(0, server.requestCount)
    }
    @Test fun `owned saved wire survives malformed adjacent metadata and HTTP errors but foreign outer owner contributes nothing`() {
        for (code in listOf(200, 503)) for (foreign in listOf(false, true)) tls { server, client ->
            val f = Fixture(server, client)
            f.store.begin(f.store.read(), f.request, f.policy); f.store.prepareAttempt(f.store.read()); f.store.acceptPreparation(f.key, f.preparation); f.store.signingAttempt(f.store.read())
            val payload = buildJsonObject {
                put("wallet", if (foreign) f.preparation.terms.seller else f.preparation.wallet); put("idempotencyKey", f.key)
                put("preparation", JsonPrimitive("bad adjacent preparation")); put("wire", f.raw.getValue("wire")); put("settlement", JsonPrimitive("bad receipt"))
            }
            server.enqueue(MockResponse().setBody(f.prep().toString())); server.enqueue(MockResponse().setResponseCode(code).setBody(payload.toString()))
            val repo = RealmSalesRepository(f.store, f.ports); assertTrue(runCatching { repo.open() }.isFailure)
            val op = f.store.read().operation!!
            assertEquals(!foreign, op.signed != null); assertEquals(!foreign, f.store.read().settlementHeld)
            assertNull(op.settlement); assertEquals(2, server.requestCount)
        }
    }
    @Test fun `authenticated failed GET error body retains attributed hold but a foreign failure cannot affect the original`() {
        for (foreign in listOf(false, true)) tls { server, client ->
            val f = Fixture(server, client); f.seed()
            val saved = buildJsonObject { put("wallet", f.preparation.wallet); put("idempotencyKey", f.key); put("preparation", f.raw.getValue("preparation")); put("wire", f.raw.getValue("wire")); put("settlement", JsonNull) }
            val failed = buildJsonObject { put("wallet", if (foreign) f.preparation.terms.seller else f.preparation.wallet); put("idempotencyKey", f.key); put("failure", JsonPrimitive("malformed proof")) }
            server.enqueue(MockResponse().setBody(f.prep().toString())); server.enqueue(MockResponse().setBody(saved.toString()))
            server.enqueue(MockResponse().setResponseCode(503).setBody(failed.toString()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            val repo = RealmSalesRepository(f.store, f.ports); assertTrue(runCatching { repo.open() }.isFailure)
            assertEquals(!foreign, f.store.read().settlementHeld); assertNull(f.cookies.value); assertEquals(3, server.requestCount)
        }
    }

}
