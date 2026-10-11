package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.mining.*
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

class MiningClaimsTransportTest {
    private class Memory : SecretStore { var bytes: String? = null; override fun read() = bytes; override fun write(value: String) { bytes = value }; override fun clear() { bytes = null } }
    private val wallet = "11111111111111111111111111111111"
    private val other = "11111111111111111111111111111112"
    private val key = "00000000-0000-4000-8000-000000000001"
    private val now = "2035-01-01T00:00:00.000Z"
    private fun claim(owner: String = wallet) = MiningClaimView(1, owner, key, "prepared", "pending", null, null,
        listOf(MiningClaimLanding(0, "claim", null, "pending", null, null, null)), now, false)
    private fun body(owner: String = wallet) = miningClaimsJson.encodeToString(MiningClaimView.serializer(), claim(owner))
    private fun failure(code: String) = """{"error":{"code":"$code","message":"Request refused"}}"""
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, block: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(cert).build(); val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { server -> server.useHttps(identity.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private inner class Fixture(server: MockWebServer, client: OkHttpClient) {
        val memory = Memory(); val jar = SessionCookieJar(server.url("/"), memory); val token = jar.sessionToken()
        val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
        var accepted: MiningClaimView? = null; var refused: ApiException? = null
        init { jar.acceptResponse(token, server.url("/"), listOf(Cookie.parse(server.url("/"), "session=fixture; Path=/; Secure; HttpOnly")!!)) }
        fun retain(raw: JsonObject) { val receipt = MiningClaimView.from(raw); require(receipt.wallet == wallet && receipt.claimId == key); accepted = receipt }
    }
    @Test fun `late authenticated same-wallet session replacement retains validated original GET before stale response refusal`() {
        lateinit var fixture: Fixture
        tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { fixture.jar.beginAuthentication() } } }) { server, client ->
            fixture = Fixture(server, client); val originalCookies = fixture.memory.bytes
            server.enqueue(MockResponse().setBody(body()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
            assertThrows(SessionSupersededException::class.java) { runBlocking { fixture.api.getMiningClaim("/claims/mining/$key", fixture.token, {}, fixture::retain) } }
            assertEquals(claim(), fixture.accepted); assertEquals(originalCookies, fixture.memory.bytes); assertEquals(1, server.requestCount)
            val request = server.takeRequest(); assertEquals("GET", request.method); assertEquals("/api/claims/mining/$key", request.path); assertEquals("session=fixture", request.getHeader("Cookie"))
        }
    }
    @Test fun `view change still retains owned evidence but a foreign receipt cannot enter the original journal`() {
        for (foreign in listOf(false, true)) {
            var current = true
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { current = false } } }) { server, client ->
                val f = Fixture(server, client); server.enqueue(MockResponse().setBody(body(if (foreign) other else wallet)))
                assertThrows(Exception::class.java) { runBlocking { f.api.getMiningClaim("/claims/mining/$key", f.token, { check(current) }, f::retain) } }
                assertEquals(if (foreign) null else claim(), f.accepted); assertEquals(1, server.requestCount)
            }
        }
    }
    @Test fun `only exact mining routes and canonical request bodies may enqueue and status cannot retain evidence`() {
        tls { server, client ->
            val f = Fixture(server, client)
            for (path in listOf("/me", "/claims/mining/status", "/claims/mining/../$key", "/claims/mining/$key?x=1", "/claims/mining/prepare/by-key/no", "/claims/mining/%2f$key"))
                assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getMiningClaim(path, f.token, {}, f::retain) } }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.getMiningClaim("/claims/mining/$key", f.token, {}) } }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.postMiningClaim("/claims/mining/prepare", buildJsonObject {}, f.token, {}, {}) } }
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.postMiningClaim("/claims/mining/submit", MiningClaimPrepareRequest(key).body(), f.token, {}, {}) } }
            assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setBody("{}")); runBlocking { f.api.getMiningClaim("/claims/mining/status", f.token, {}) }; assertNull(f.accepted)
        }
    }
    @Test fun `prepare refusal whitelist runs once before stale session guard and never applies to submit`() {
        val pairs = listOf(400 to "INVALID_INPUT", 422 to "INSUFFICIENT_SOL", 409 to "CLAIM_ROOT_PENDING", 409 to "CLAIM_BLOCKHASH_REUSED", 503 to "PHASE_E_DISABLED")
        for ((status, code) in pairs) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { f.jar.beginAuthentication() } } }) { server, client ->
                f = Fixture(server, client); server.enqueue(MockResponse().setResponseCode(status).setBody(failure(code)))
                var calls = 0
                assertThrows(SessionSupersededException::class.java) { runBlocking { f.api.postMiningClaim("/claims/mining/prepare", MiningClaimPrepareRequest(key).body(), f.token, {}, {}, { f.refused = it; calls++ }) } }
                assertEquals(code, f.refused?.code); assertEquals(1, calls); assertEquals(1, server.requestCount)
                val request = server.takeRequest(); assertEquals("POST", request.method); assertEquals(MiningClaimPrepareRequest(key).body().toString(), request.body.readUtf8()); assertNull(request.getHeader("x-pkw-currency"))
            }
        }
        tls { server, client -> val f = Fixture(server, client)
            val wire = java.util.Base64.getEncoder().encodeToString(ByteArray(66))
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.api.postMiningClaim("/claims/mining/submit", MiningClaimSubmitRequest(key, wire).body(), f.token, {}, refusal = {}) } }
            assertEquals(0, server.requestCount)
        }
    }
    @Test fun `unauthorized malformed missing and oversized replies do not produce evidence or definitive refusal`() {
        val cases = listOf(401 to body(), 200 to "", 200 to "[]", 200 to "{", 200 to "{}", 200 to (" ".repeat(32769) + body()),
            503 to failure("CLAIM_UNAVAILABLE"), 409 to failure("INSUFFICIENT_SOL"), 422 to """{"code":"INSUFFICIENT_SOL","message":"missing envelope"}""",
            422 to """{"error":{"code":"INSUFFICIENT_SOL"}}""", 422 to """{"error":{"code":"INSUFFICIENT_SOL","message":1}}""",
            422 to """{"error":{"code":"INSUFFICIENT_SOL","message":""}}""", 422 to (" ".repeat(32769) + failure("INSUFFICIENT_SOL")))
        tls { server, client ->
            val f = Fixture(server, client)
            for ((status, value) in cases) {
                server.enqueue(MockResponse().setResponseCode(status).setBody(value))
                assertThrows(Exception::class.java) { runBlocking { f.api.postMiningClaim("/claims/mining/prepare", MiningClaimPrepareRequest(key).body(), f.token, {}, f::retain, { f.refused = it }) } }
                assertNull(f.accepted); assertNull(f.refused)
            }
            assertEquals(cases.size, server.requestCount)
        }
    }
    @Test fun `successful exact POST retains only validated response once with no retry or hidden GET`() {
        val policy = MiningClaimsProtocolPolicy(9, 1, 120)
        val p = MiningClaimPreparationView(1, wallet, key, key, key, 1, "1", "1", "ab".repeat(32), "80",
            MiningClaimIdentity(wallet, wallet, wallet, other, other), MiningClaimLeaf(wallet, "1", "80", "0", "0"), emptyList(), false, false,
            MiningClaimFees("5000", "0", "5000", "10000"), listOf(MiningClaimTransaction(0, "claim", "legacy", "AQ==", emptyList(), wallet, other, 100, "5000", "0")),
            now, "2035-01-01T00:02:00.000Z", now, "prepared", false, false)
        tls { server, client -> val f = Fixture(server, client); server.enqueue(MockResponse().setBody(miningClaimsJson.encodeToString(MiningClaimPreparationView.serializer(), p)))
            var accepted: MiningClaimPreparationView? = null
            runBlocking { f.api.postMiningClaim("/claims/mining/prepare", MiningClaimPrepareRequest(key).body(), f.token, {}, { raw ->
                val value = MiningClaimPreparationView.from(raw, policy); require(value.wallet == wallet && value.idempotencyKey == key); accepted = value
            }) }
            assertEquals(p, accepted); assertEquals(1, server.requestCount); assertEquals("POST", server.takeRequest().method)
        }
    }
    @Test fun `chunked and compressed response bytes are bounded even without declared length`() {
        tls { server, client -> val f = Fixture(server, client)
            val oversized = " ".repeat(32769) + body()
            val compressed = okio.Buffer(); okio.GzipSink(compressed).buffer().use { it.writeUtf8(oversized) }
            for (response in listOf(MockResponse().setChunkedBody(oversized, 1024), MockResponse().setBody(compressed).addHeader("Content-Encoding", "gzip"))) {
                server.enqueue(response)
                assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.api.getMiningClaim("/claims/mining/$key", f.token, {}, f::retain) } }
                assertNull(f.accepted)
            }
            assertEquals(2, server.requestCount)
        }
    }
    @Test fun `incomplete response drain honors read deadline and does not record an apparent refusal`() {
        tls { server, client ->
            val bounded = client.newBuilder().addInterceptor { chain ->
                val response = chain.proceed(chain.request()); val body = requireNotNull(response.body)
                val source = object : okio.ForwardingSource(body.source()) { override fun read(sink: okio.Buffer, byteCount: Long): Long { timeout().timeout(100, TimeUnit.MILLISECONDS); return super.read(sink, byteCount) } }.buffer()
                response.newBuilder().body(object : ResponseBody() { override fun contentType() = body.contentType(); override fun contentLength() = body.contentLength(); override fun source() = source }).build()
            }.build()
            val f = Fixture(server, bounded); server.enqueue(MockResponse().setResponseCode(422).setBody(failure("INSUFFICIENT_SOL")).setBodyDelay(500, TimeUnit.MILLISECONDS))
            assertThrows(IOException::class.java) { runBlocking { f.api.postMiningClaim("/claims/mining/prepare", MiningClaimPrepareRequest(key).body(), f.token, {}, f::retain, { f.refused = it }) } }
            assertNull(f.accepted); assertNull(f.refused); assertEquals(1, server.requestCount)
        }
    }
}
