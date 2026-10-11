package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testHolder
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Dedicated JVM task only. Real native consent/storage/HTTP decoding meets the
 * authenticated Fastify API and PostgreSQL ledger; no Android runtime or RPC. */
class GemsApiPairedTest {
    @Test fun `native Gems to SHARDS conversion publishes only its exact receipt and four conserved legs`() = Fixture().use { f -> runBlocking {
        val c = f.client()
        c.repository.review(IntentKind.GEMS_FROM_KEEP, "5")
        val purchase = requireNotNull(c.repository.state.value.review)
        c.repository.confirm(purchase)
        c.repository.review(IntentKind.GEMS_TO_SHARDS, "1")
        val review = requireNotNull(c.repository.state.value.review)
        c.repository.confirm(review)
        val receipt = requireNotNull(c.repository.state.value.receipt)
        assertEquals("SHARDS", receipt.currency); assertEquals(review.output, receipt.amount)
        assertNull(receipt.baseId)
        assertEquals("15", c.repository.state.value.balances?.keep)
        assertEquals((purchase.output.toBigInteger() - 1.toBigInteger()).toString(), c.repository.state.value.balances?.gems)
        assertEquals(review.output, c.repository.state.value.balances?.shards)
        assertTrue(c.store.all(f.wallet).isEmpty())
        val inspection = f.inspect(review.intent.idempotencyKey, "to-shards")
        assertEquals(listOf(receipt.receiptId), inspection.getValue("transactions").jsonArray.map { it.jsonPrimitive.content })
        val expected = listOf(
            leg(f, "player_gems", "GEMS", "-1", f.wallet),
            leg(f, "gems_sink", "GEMS", "1", null),
            leg(f, "shard_genesis", "SHARDS", "-${review.output}", null),
            leg(f, "player_shards", "SHARDS", review.output, f.wallet),
        ).sortedBy { it.getValue("accountId").jsonPrimitive.content }
        assertEquals(expected, inspection.getValue("entries").jsonArray.sortedBy { it.jsonObject.getValue("accountId").jsonPrimitive.content })
        assertEquals(listOf(purchase.intent.body, review.intent.body), f.posts.map { it.getValue("body") })
        assertEquals(2, c.hydrations)
    } }

    @Test fun `native KEEP conversion publishes only the proved credit and exact replay cannot debit twice`() = Fixture().use { f -> runBlocking {
        val c = f.client()
        c.repository.review(IntentKind.GEMS_FROM_KEEP, "5")
        val review = requireNotNull(c.repository.state.value.review)
        assertEquals((5L * f.rate).toString(), review.output)
        c.repository.confirm(review)
        assertEquals(review.intent.body, f.posts.single().getValue("body"))
        assertTrue(f.posts.single().getValue("journal").jsonObject.getValue("attempted").jsonPrimitive.boolean)
        val receipt = requireNotNull(c.repository.state.value.receipt)
        assertEquals(review.output, receipt.amount)
        assertEquals("15", c.repository.state.value.balances?.keep)
        assertEquals(review.output, c.repository.state.value.balances?.gems)
        assertEquals("0", c.repository.state.value.balances?.shards)
        assertTrue(c.store.all(f.wallet).isEmpty())
        assertTrue("Fresh API balances must be published before retiring the journal", c.hydrations > 0)
        val committed = f.inspect(review.intent.idempotencyKey)
        assertPosting(f, committed, receipt.receiptId, review.output)
        val replay = c.api.postMoneyCommand(review.intent.path, review.intent.body, null, {}, {})
        assertTrue(replay.getValue("duplicate").jsonPrimitive.boolean)
        assertEquals(receipt.receiptId, replay.getValue("receiptId").jsonPrimitive.content)
        assertEquals(committed, f.inspect(review.intent.idempotencyKey))
        assertEquals(2, f.posts.size)
    } }

    @Test fun `committed lost response survives native and paused API restart with receipt-only recovery`() = Fixture().use { f -> runBlocking {
        val first = f.client()
        first.repository.review(IntentKind.GEMS_FROM_KEEP, "5")
        val review = requireNotNull(first.repository.state.value.review)
        f.loseNextPostResponse = true
        assertTrue(runCatching { first.repository.confirm(review) }.exceptionOrNull() is IOException)
        val pending = requireNotNull(first.store.get(review.intent.kind, f.wallet))
        assertTrue(pending.attempted); assertNull(pending.receipt)
        assertNull(first.repository.state.value.receipt)
        val committed = f.inspect(review.intent.idempotencyKey)
        assertEquals(1, f.posts.size)
        assertEquals(201, f.posts.single().getValue("status").jsonPrimitive.int)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        // A new storage object parses persisted bytes, and the repository/session
        // are recreated. Nothing survives through a captured in-memory intent.
        val recovered = f.client(MemoryStore(first.disk.value))
        assertEquals(pending, recovered.store.get(review.intent.kind, f.wallet))
        recovered.repository.check(review.intent.kind)
        val receipt = requireNotNull(recovered.repository.state.value.receipt)
        assertEquals(review.output, receipt.amount)
        assertEquals("15", recovered.repository.state.value.balances?.keep)
        assertNull("Paused API intentionally omits Gems from current balances", recovered.repository.state.value.balances?.gems)
        assertEquals("0", recovered.repository.state.value.balances?.shards)
        assertTrue(recovered.store.all(f.wallet).isEmpty())
        assertPosting(f, committed, receipt.receiptId, review.output)
        assertEquals(committed, f.inspect(review.intent.idempotencyKey))
        assertTrue(runCatching { recovered.repository.review(IntentKind.GEMS_FROM_KEEP, "1") }.isFailure)
        assertEquals("Recovery and paused admission must not send a second POST", 1, f.posts.size)
    } }

    @Test fun `real insufficient KEEP refusal leaves no receipt or native success publication`() = Fixture().use { f -> runBlocking {
        val c = f.client()
        c.repository.review(IntentKind.GEMS_FROM_KEEP, "21")
        val review = requireNotNull(c.repository.state.value.review)
        val refusal = runCatching { c.repository.confirm(review) }.exceptionOrNull() as ApiException
        assertEquals(422, refusal.status); assertEquals("INSUFFICIENT_KEEP", refusal.code)
        assertNull(c.repository.state.value.receipt); assertEquals(0, c.hydrations)
        assertTrue(c.store.all(f.wallet).isEmpty())
        val inspection = f.inspect(review.intent.idempotencyKey)
        assertEquals(JsonArray(emptyList()), inspection.getValue("transactions"))
        assertEquals(JsonArray(emptyList()), inspection.getValue("entries"))
        assertEquals(buildJsonObject { put("keep", "20"); put("gems", "0"); put("shards", "0") }, inspection.getValue("balances"))
        assertEquals(1, f.posts.size)
    } }

    private fun assertPosting(f: Fixture, inspection: JsonObject, receiptId: String, output: String) {
        assertEquals(listOf(receiptId), inspection.getValue("transactions").jsonArray.map { it.jsonPrimitive.content })
        val expected = listOf(
            leg(f, "player_keep", "KEEP", "-5", f.wallet),
            leg(f, "emission_pool", "KEEP", "5", null),
            leg(f, "gems_mint", "GEMS", "-$output", null),
            leg(f, "player_gems", "GEMS", output, f.wallet),
        ).sortedBy { it.getValue("accountId").jsonPrimitive.content }
        assertEquals(expected, inspection.getValue("entries").jsonArray.sortedBy { it.jsonObject.getValue("accountId").jsonPrimitive.content })
        assertEquals(buildJsonObject { put("keep", "15"); put("gems", output); put("shards", "0") }, inspection.getValue("balances"))
    }
    private fun leg(f: Fixture, kind: String, currency: String, delta: String, wallet: String?) = buildJsonObject {
        put("accountId", f.accountIds.getValue(kind)); put("kind", kind); put("currency", currency)
        put("ownerWallet", wallet?.let(::JsonPrimitive) ?: JsonNull); put("baseId", JsonNull); put("delta", delta)
    }

    private class Client(f: Fixture, val disk: MemoryStore) {
        private val holder = testHolder()
        private val cookies = SessionCookieJar(f.server.url("/"), MemoryStore()).apply {
            saveFromResponse(f.server.url("/"), listOf(requireNotNull(Cookie.parse(f.server.url("/"), f.cookie))))
        }
        private val game = GameApi.withTransport(f.server.url("/").toString(), cookies, "native-paired-fixture", f.transport)
        private val session = AccountSession(f.wallet, f.server.url("/").toString().trimEnd('/'), game.sessionToken()).also(holder::replace)
        val api = SessionApiClient(game, session.token, ApiRouting())
        val store = PendingIntentStore(disk)
        private var directory: BaseDirectory? = null
        var hydrations = 0
        val repository = GemsRepository(session, holder, api, store, ReceiptObserver(store), { null }, { 0L }, { directory }, {
            assertEquals(f.wallet, api.get("/me").getValue("wallet").jsonPrimitive.content)
            directory = BaseDirectory.from(api.get("/bases"))
        }, {
            // The real repository has already decoded /balances. Its durable
            // proof must still exist when destination hydration is published.
            assertNotNull(store.all(f.wallet).single().receipt)
            hydrations++
        })
    }

    private class Fixture : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val bridge = Bridge()
        private val setup = try {
            bridge.command(buildJsonObject { put("op", "start"); put("origin", server.url("/").toString().trimEnd('/')) })
        } catch (error: Throwable) {
            runCatching { bridge.close() }; server.shutdown()
            transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown()
            throw error
        }
        val wallet = setup.getValue("wallet").jsonPrimitive.content
        val cookie = setup.getValue("cookie").jsonPrimitive.content
        val rate = setup.getValue("gemsPerKeep").jsonPrimitive.long
        val accountIds = setup.getValue("accountIds").jsonObject
        val posts = mutableListOf<JsonObject>()
        @Volatile var loseNextPostResponse = false
        @Volatile private var active: Client? = null
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val body = request.body.readUtf8()
                    val response = try { bridge.command(buildJsonObject {
                        put("op", "request"); put("method", request.method); put("url", request.path)
                        put("headers", buildJsonObject { request.headers.names().forEach { put(it, request.getHeader(it)) } })
                        if (body.isNotEmpty()) put("body", body)
                    }) } catch (error: Exception) {
                        // Fail this client request promptly if the fixture itself
                        // rejected its protocol; never wait for a socket timeout.
                        return MockResponse().setResponseCode(500).setBody(buildJsonObject {
                            put("error", buildJsonObject { put("code", "PAIRED_FIXTURE_ERROR"); put("message", error.message) })
                        }.toString())
                    }
                    if (request.method == "POST") {
                        val journal = active?.store?.all(wallet)?.singleOrNull()
                        posts += buildJsonObject {
                            put("body", Json.parseToJsonElement(body)); put("status", response.getValue("status"))
                            put("journal", buildJsonObject { put("attempted", journal?.attempted == true) })
                        }
                        if (loseNextPostResponse) {
                            loseNextPostResponse = false
                            return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        }
                    }
                    return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int)
                        .setHeader("Content-Type", "application/json").setBody(response.getValue("body").jsonPrimitive.content)
                }
            }
        }
        fun client(disk: MemoryStore = MemoryStore()) = Client(this, disk).also { active = it }
        fun inspect(key: String, kind: String = "from-keep") = bridge.command(buildJsonObject { put("op", "inspect"); put("key", key); put("kind", kind) })
        override fun close() {
            try { bridge.close() } finally {
                server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown()
            }
        }
    }

    /** The fixture has no TCP listener. Only this test's private pipes can issue
     * control commands; every player request still crosses GameApi's HTTPS path. */
    private class Bridge : AutoCloseable {
        private val root = File(requireNotNull(System.getenv("PHASE_E_API_ROOT")))
        private val script = root.resolve("apps/api/test/fixtures/nativeGemsApiFixture.ts").also { require(it.isFile) }
        private val process = ProcessBuilder("node", "--import", "tsx", script.absolutePath)
            .directory(root.resolve("apps/api")).redirectError(ProcessBuilder.Redirect.INHERIT).apply {
                environment()["NODE_ENV"] = "test"
                environment()["PHASE_E_NATIVE_PAIRED"] = "1"
            }.start()
        private val input = process.outputStream.bufferedWriter()
        private val output = process.inputStream.bufferedReader()
        private val reads = Executors.newSingleThreadExecutor()
        @Synchronized fun command(value: JsonObject): JsonObject {
            input.write(value.toString()); input.newLine(); input.flush()
            val line = reads.submit<String> {
                while (true) {
                    val next = output.readLine() ?: error("Native API fixture exited before its reply")
                    if (next.startsWith(PREFIX)) return@submit next.removePrefix(PREFIX)
                }
                @Suppress("UNREACHABLE_CODE") error("unreachable")
            }.get(60, TimeUnit.SECONDS)
            val result = Json.parseToJsonElement(line).jsonObject
            check(result["error"] == null) { "Native API fixture failed: ${result["error"]}" }
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
        companion object { const val PREFIX = "NATIVE_GEMS_FIXTURE:" }
    }
}
