package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Native wallet purchase against authenticated Fastify and its real chain
 * verifiers. Only wallet approval, RPC authority and platform storage are fixtures. */
class GemsBuyApiPairedTest {
    @Test fun `native wallet purchase preserves signature before one relay and credits exactly once`() = Fixture().use { f -> runBlocking {
        val c = f.client(); c.repository.review("10"); c.repository.pay(c.sender)
        credited(f, c)
        val before = f.posts.size
        assertTrue(runCatching { c.repository.pay(c.sender) }.isFailure)
        c.repository.check(); c.repository.open()
        assertEquals(before, f.posts.size); credited(f, c)
        val q = requireNotNull(c.store.read()?.quote)
        c.api.post("/deposits/${q.id}/verify")
        credited(f, c)
        assertEquals(1, f.approvals); assertEquals(1, f.relays)
    } }

    @Test fun `lost admitted response recovers original key before any wallet call`() = Fixture().use { f -> runBlocking {
        val first = f.client(); f.losePath = "/api/deposits"
        assertTrue(runCatching { first.repository.review("10") }.isFailure)
        val draft = requireNotNull(first.store.read()).draft
        assertNull(first.store.read()?.quote); assertEquals(0, f.approvals)
        assertEquals(1, f.inspect().getValue("depositCount").jsonPrimitive.int)
        f.restart(false)
        val c = f.client(MemoryStore(first.disk.value)); val posts = f.posts.size
        c.repository.open()
        assertEquals(draft, c.store.read()?.draft); assertNotNull(c.store.read()?.quote)
        assertEquals(posts, f.posts.size); assertEquals(0, f.approvals)
        c.repository.reviewSaved(); c.repository.pay(c.sender); credited(f, c)
    } }

    @Test fun `lost committed response recovers after native and API restart`() = lostCredit(false)
    @Test fun `lost committed response recovers while paused without another wallet call`() = lostCredit(true)
    private fun lostCredit(paused: Boolean) = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repository.review("10")
        val quote = requireNotNull(first.store.read()?.quote)
        f.losePath = "/api/deposits/${quote.id}/verify"
        assertTrue(runCatching { first.repository.pay(first.sender) }.isFailure)
        val saved = requireNotNull(first.store.read())
        assertTrue(saved.attempted); assertNotNull(saved.signature); assertNull(saved.observed?.receipt)
        assertFalse(first.repository.state.value.hydrated)
        val committed = f.inspect(); assertEquals(1, committed.getValue("credits").jsonArray.size)
        f.restart(paused)
        val c = f.client(MemoryStore(first.disk.value)); val posts = f.posts.size
        assertEquals(saved, c.store.read()); c.repository.open(); c.repository.check()
        assertEquals(posts, f.posts.size); assertEquals(committed, f.inspect())
        credited(f, c, paused)
        assertTrue(runCatching { c.repository.pay(c.sender) }.isFailure)
        assertEquals(1, f.approvals); assertEquals(1, f.relays)
        if (paused) {
            val refused = runCatching { c.api.post("/deposits", buildJsonObject {
                put("kind", "gems_buy"); put("keepIn", 10); put("idempotencyKey", java.util.UUID.randomUUID().toString())
            }) }.exceptionOrNull() as ApiException
            assertEquals(503, refused.status); assertEquals("GEMS_WALLET_BUY_DISABLED", refused.code)
            assertEquals(committed, f.inspect())
        }
    } }

    @Test fun `confirmed transfer cannot credit until finalized fixture proof arrives during pause`() = Fixture(finalized = false).use { f -> runBlocking {
        val c = f.client(); c.repository.review("10"); runCatching { c.repository.pay(c.sender) }
        assertEquals(1, f.approvals); assertEquals(1, f.relays); assertNotNull(c.store.read()?.signature)
        assertNull(c.store.read()?.observed?.receipt); assertFalse(c.repository.state.value.hydrated)
        assertTrue(f.inspect().getValue("credits").jsonArray.isEmpty())
        f.bridge.command(buildJsonObject { put("op", "finalize") }); f.restart(true)
        val restored = f.client(MemoryStore(c.disk.value)); restored.repository.open()
        assertFalse(restored.repository.state.value.hydrated)
        restored.repository.check(); restored.repository.check(); credited(f, restored, true)
        assertEquals(1, f.approvals); assertEquals(1, f.relays)
    } }

    @Test fun `wallet KEEP shortfall refuses before approval relay or credit`() = Fixture(walletKeep = 1).use { f -> runBlocking {
        val c = f.client(); c.repository.review("10")
        assertTrue(runCatching { c.repository.pay(c.sender) }.isFailure)
        assertEquals(0, f.approvals); assertEquals(0, f.relays)
        assertFalse(requireNotNull(c.store.read()).attempted)
        assertTrue(f.inspect().getValue("credits").jsonArray.isEmpty())
        f.restart(false); val restored = f.client(MemoryStore(c.disk.value)); restored.repository.open()
        assertEquals(0, f.approvals); assertEquals(0, f.relays)
        assertFalse(restored.repository.state.value.hydrated)
    } }

    private fun credited(f: Fixture, c: Client, paused: Boolean = false) {
        val saved = requireNotNull(c.store.read()); val q = requireNotNull(saved.quote)
        val receipt = requireNotNull(saved.observed?.receipt)
        assertEquals(q.id, receipt.depositId); assertEquals(saved.signature, receipt.txSignature)
        assertEquals(q.wallet, receipt.wallet); assertEquals(q.keepIn.toString(), receipt.funding.amount)
        assertEquals(q.baseUnits.toString(), receipt.funding.baseUnits); assertEquals(q.gemsOut.toString(), receipt.result.amount)
        assertTrue(c.repository.state.value.hydrated); assertNotNull(c.walletBalances.state.value)
        assertEquals((f.walletKeep - q.keepIn).toString(), c.walletBalances.state.value?.tokens?.get("KEEP"))
        assertEquals("0", c.published?.keep); assertEquals("0", c.published?.shards)
        assertEquals(if (paused) null else q.gemsOut.toString(), c.published?.gems)
        val state = f.inspect()
        assertEquals(1, state.getValue("depositCount").jsonPrimitive.int)
        assertEquals(listOf(receipt.receiptId), state.getValue("credits").jsonArray.map { it.jsonPrimitive.content })
        assertEquals("0", state.getValue("keep").jsonPrimitive.content)
        assertEquals(q.gemsOut.toString(), state.getValue("gems").jsonPrimitive.content)
        fun leg(kind: String, currency: String, delta: String, owner: String?) = buildJsonObject {
            put("accountId", f.setup.getValue("accountIds").jsonObject.getValue(kind)); put("kind", kind)
            put("currency", currency); put("delta", delta); put("ownerWallet", owner?.let(::JsonPrimitive) ?: JsonNull); put("baseId", JsonNull)
        }
        val expected = listOf(leg("onchain_inflow", "KEEP", "-${q.keepIn}", null),
            leg("emission_pool", "KEEP", q.keepIn.toString(), null), leg("gems_mint", "GEMS", "-${q.gemsOut}", null),
            leg("player_gems", "GEMS", q.gemsOut.toString(), f.wallet)).toSet()
        val entries = state.getValue("entries").jsonArray
        assertEquals(4, entries.size); assertEquals(expected, entries.toSet())
        assertEquals(1, f.approvals); assertEquals(1, f.relays)
    }

    private class Client(val f: Fixture, val disk: MemoryStore) {
        private val holder = testHolder()
        private val jar = SessionCookieJar(f.server.url("/"), MemoryStore()).apply {
            saveFromResponse(f.server.url("/"), listOf(requireNotNull(Cookie.parse(f.server.url("/"), f.setup.getValue("cookie").jsonPrimitive.content))))
        }
        private val game = GameApi.withTransport(f.origin, jar, "native-buy-paired-fixture", f.transport)
        private val session = AccountSession(f.wallet, f.origin, game.sessionToken()).also(holder::replace)
        val api = SessionApiClient(game, session.token, ApiRouting())
        val store = GemsBuyStore(disk, f.wallet, f.origin, "devnet")
        private val catalog = f.setup.getValue("catalogue").jsonObject
        private val mint = f.setup.getValue("mint").jsonPrimitive.content
        var published: Balances? = null
        val walletBalances = GemsBuyBalances(session, holder, api, {
            assertEquals(f.wallet, api.get("/me").getValue("wallet").jsonPrimitive.content)
            assertFalse(BaseDirectory.from(api.get("/bases")).enabled)
        }, { true }, {
            assertNotNull("Receipt must be durable before current balances publish", store.read()?.observed?.receipt)
            published = Balances.from(api.get("/balances"))
        })
        private val rpc = SolanaRpc { request ->
            if (request.string("method") == "sendTransaction") {
                val saved = requireNotNull(store.read()); assertTrue(saved.attempted); assertNotNull(saved.signature)
                val bytes = Base64.getDecoder().decode(request.getValue("params").jsonArray[0].jsonPrimitive.content)
                assertEquals(saved.signature, base58(bytes.copyOfRange(1, 65))); f.relays++
            }
            f.bridge.command(buildJsonObject { put("op", "rpc"); put("request", request) })
        }
        private val payment = GemsBuyPayment(rpc, SolanaCluster.DEVNET, mint)
        val repository = GemsBuyRepository(session, holder, api, store, SolanaCluster.DEVNET, { mint },
            { KeepDepositBounds.from(catalog) }, payment::prepare, walletBalances::refresh, { 1000L }, {
                catalog.getValue("constants").jsonObject.getValue("ECONOMY").jsonObject.getValue("depositReuseMinRemainingMin").jsonPrimitive.long * 60_000L
            })
        val sender = GemsBuyWallet(session, holder, f.origin, SolanaCluster.DEVNET, payment,
            { false }, { null }, GemsBuyPayer { tx, cluster, wallet, _, onSigned, guard ->
                assertEquals(SolanaCluster.DEVNET, cluster); assertEquals(f.wallet, wallet); guard()
                assertEquals(1, tx[0].toInt()); f.approvals++
                val wire = tx.copyOf(); val signer = Signature.getInstance("Ed25519")
                signer.initSign(f.keys.private); signer.update(wire.copyOfRange(65, wire.size)); signer.sign().copyInto(wire, 1)
                onSigned(wire); guard()
                WalletPayment.SignedOnly(wire, wire.copyOfRange(1, 65), TransactionMutation.NONE, null)
            }, repository::requirePaymentWindow, {})
    }

    private class Fixture(finalized: Boolean = true, val walletKeep: Int = 20) : AutoCloseable {
        val keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val wallet = base58(keys.public.encoded.takeLast(32).toByteArray())
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val origin = server.url("/").toString().trimEnd('/')
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val bridge = Bridge()
        val setup = try { bridge.command(buildJsonObject {
            put("op", "start"); put("origin", origin); put("wallet", wallet); put("finalized", finalized); put("walletKeep", walletKeep)
        }) } catch (e: Throwable) {
            runCatching { bridge.close() }; server.shutdown(); transport.dispatcher.executorService.shutdown(); throw e
        }
        val posts = mutableListOf<Pair<String, Int>>()
        @Volatile var losePath: String? = null
        var approvals = 0; var relays = 0
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = request.body.readUtf8()
                    val response = try { bridge.command(buildJsonObject {
                        put("op", "request"); put("method", request.method); put("url", request.path)
                        put("headers", buildJsonObject { request.headers.names().forEach { put(it, request.getHeader(it)) } })
                        if (body.isNotEmpty()) put("body", body)
                    }) } catch (error: Exception) {
                        return MockResponse().setResponseCode(500).setBody(buildJsonObject {
                            put("error", buildJsonObject { put("code", "PAIRED_FIXTURE_ERROR"); put("message", error.message) })
                        }.toString())
                    }
                    if (request.method == "POST") {
                        posts += requireNotNull(request.path) to response.getValue("status").jsonPrimitive.int
                        if (losePath == request.path) {
                            losePath = null
                            return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        }
                    }
                    return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int)
                        .setHeader("Content-Type", "application/json").setBody(response.getValue("body").jsonPrimitive.content)
                }
            }
        }
        fun client(disk: MemoryStore = MemoryStore()) = Client(this, disk)
        fun restart(paused: Boolean) = bridge.command(buildJsonObject { put("op", "restart"); put("paused", paused) })
        fun inspect() = bridge.command(buildJsonObject { put("op", "inspect") })
        override fun close() {
            try { bridge.close() } finally { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
        }
    }
    private class Bridge : AutoCloseable {
        private val root = File(requireNotNull(System.getenv("PHASE_E_API_ROOT")))
        private val script = root.resolve("apps/api/test/fixtures/nativeGemsBuyApiFixture.ts").also { require(it.isFile) }
        private val process = ProcessBuilder("node", "--import", "tsx", script.absolutePath)
            .directory(root.resolve("apps/api")).redirectError(ProcessBuilder.Redirect.INHERIT).apply {
                environment()["NODE_ENV"] = "test"
                environment()["PHASE_E_NATIVE_PAIRED"] = "1"
            }.start()
        private val input = process.outputStream.bufferedWriter()
        private val output = process.inputStream.bufferedReader()
        private val reads = Executors.newSingleThreadExecutor()
        private var failure: IllegalStateException? = null
        @Synchronized fun command(value: JsonObject): JsonObject {
            failure?.let { throw it }
            input.write(value.toString()); input.newLine(); input.flush()
            val line = reads.submit<String> {
                while (true) {
                    val next = output.readLine() ?: error("Native API fixture exited before its reply")
                    if (next.startsWith(PREFIX)) return@submit next.removePrefix(PREFIX)
                }
                @Suppress("UNREACHABLE_CODE") error("unreachable")
            }.get(60, TimeUnit.SECONDS)
            val result = Json.parseToJsonElement(line).jsonObject
            if (result["error"] != null) {
                throw IllegalStateException("Native API fixture failed: ${result["error"]}").also { failure = it }
            }
            return result
        }
        override fun close() {
            try {
                // EOF is also a cleanup signal if a fixture command failed.
                input.close()
                check(process.waitFor(10, TimeUnit.SECONDS)) { "Native API fixture did not stop" }
                check(process.exitValue() == 0) { "Native API fixture cleanup failed" }
            } finally {
                process.destroyForcibly(); reads.shutdownNow(); output.close()
            }
        }
        companion object { const val PREFIX = "NATIVE_GEMS_BUY_FIXTURE:" }
    }
}
