package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.freebase.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testHolder
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Real GameApi HTTPS crosses a private-pipe Fastify/ledger fixture; JVM only. */
class FreeBaseApiPairedTest {
    @Test fun `reviewed purchase burns exact source SHARDS and exposes two selectable kingdoms without changing selection`() = Fixture().use { f -> runBlocking {
        val c = f.client(); c.repository.refresh(); c.repository.reviewPurchase()
        val review = requireNotNull(c.repository.state.value.review)
        assertEquals(f.costShards, review.command.terms.costShards)
        c.repository.confirm(review)
        val receipt = requireNotNull(c.store.read().operation?.receipt)
        assertPosting(f, receipt)
        assertEquals(review.command.request.body(), f.posts.single().getValue("body"))
        assertTrue(f.posts.single().getValue("journal").jsonObject.getValue("attempted").jsonPrimitive.boolean)
        assertEquals(setOf(f.sourceBaseId, receipt.baseId), c.directory!!.bases.filter { it.selectable }.map { it.id }.toSet())
        assertEquals(f.sourceBaseId, c.selected)
        assertEquals(receipt, c.repository.state.value.journal.operation!!.receipt)
    } }
    @Test fun `lost reply survives journal reload and paused API restart with GET-only receipt recovery`() = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repository.refresh(); first.repository.reviewPurchase()
        val review = requireNotNull(first.repository.state.value.review)
        f.loseNextPostResponse = true
        assertTrue(runCatching { first.repository.confirm(review) }.exceptionOrNull() is IOException)
        val saved = requireNotNull(first.store.read().operation)
        assertNotNull(saved.attemptRevision); assertNull(saved.receipt); assertEquals(1, f.posts.size)
        val committed = f.inspect(review.command.key)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovered = f.client(MemoryStore(first.disk.value)); recovered.selected = null; recovered.allowed = false
        assertEquals(saved, recovered.store.read().operation)
        recovered.repository.refresh()
        val receipt = requireNotNull(recovered.store.read().operation?.receipt)
        assertPosting(f, receipt); assertEquals(committed, f.inspect(review.command.key))
        assertEquals(receipt, recovered.repository.state.value.view!!.receipt)
        assertFalse(recovered.repository.state.value.view!!.enabled); assertNull(recovered.selected)
        assertEquals(1, f.posts.size)
        // A different device can also show wallet history without a journal or selection.
        val otherDevice = f.client(); otherDevice.selected = null; otherDevice.allowed = false
        otherDevice.repository.refresh(); assertEquals(receipt, otherDevice.repository.state.value.view!!.receipt)
        assertNull(otherDevice.store.read().operation); assertEquals(1, f.posts.size)
    } }
    @Test fun `concurrent explicit confirms share one durable request and cannot debit twice`() = Fixture().use { f -> runBlocking {
        val c = f.client(); c.repository.refresh(); c.repository.reviewPurchase()
        val review = requireNotNull(c.repository.state.value.review)
        val outcomes = listOf(async { runCatching { c.repository.confirm(review) } }, async { runCatching { c.repository.confirm(review) } }).awaitAll()
        assertEquals(1, outcomes.count { it.isSuccess }); assertEquals(1, f.posts.size)
        assertPosting(f, requireNotNull(c.store.read().operation?.receipt))
        c.repository.check(); assertEquals(1, f.posts.size)
    } }
    @Test fun `source funds lost after review refuse fresh admission without sending a purchase`() = Fixture().use { f -> runBlocking {
        val c = f.client(); c.repository.refresh(); c.repository.reviewPurchase()
        val review = requireNotNull(c.repository.state.value.review)
        f.bridge.command(buildJsonObject { put("op", "drain-source") })
        assertTrue(runCatching { c.repository.confirm(review) }.isFailure)
        assertTrue(f.posts.isEmpty()); assertNull(c.store.read().operation?.receipt)
        val inspection = f.inspect(review.command.key)
        assertEquals(JsonArray(emptyList()), inspection.getValue("transactions")); assertEquals(JsonArray(emptyList()), inspection.getValue("entries"))
        assertEquals(1, inspection.getValue("bases").jsonArray.size)
    } }
    private fun assertPosting(f: Fixture, receipt: FreeBasePurchaseReceipt) {
        val inspection = f.inspect(receipt.idempotencyKey)
        assertEquals(listOf(receipt.debitTransactionId), inspection.getValue("transactions").jsonArray.map { it.jsonPrimitive.content })
        assertEquals("0", inspection.getValue("sourceShards").jsonPrimitive.content)
        assertEquals(setOf(f.sourceBaseId, receipt.baseId), inspection.getValue("bases").jsonArray.map { it.jsonPrimitive.content }.toSet())
        val entries = inspection.getValue("entries").jsonArray.map { it.jsonObject }
        assertEquals(2, entries.size)
        val source = entries.single { it.getValue("kind").jsonPrimitive.content == "base_shards" }
        val burn = entries.single { it.getValue("kind").jsonPrimitive.content == "shard_burn" }
        assertEquals(f.sourceBaseId, source.getValue("baseId").jsonPrimitive.content)
        assertEquals("-${f.costShards}", source.getValue("delta").jsonPrimitive.content)
        assertEquals(f.costShards, burn.getValue("delta").jsonPrimitive.content)
        assertEquals(JsonNull, burn.getValue("ownerWallet")); assertEquals(JsonNull, burn.getValue("baseId"))
        assertTrue(entries.all { it.getValue("currency").jsonPrimitive.content == "SHARDS" })
        assertEquals(receipt, FreeBasePurchaseReceipt.from(inspection.getValue("receipt").jsonObject))
    }
    private class Client(f: Fixture, val disk: MemoryStore) {
        private val holder = testHolder()
        private val cookies = SessionCookieJar(f.server.url("/"), MemoryStore()).apply {
            saveFromResponse(f.server.url("/"), listOf(requireNotNull(Cookie.parse(f.server.url("/"), f.cookie))))
        }
        private val game = GameApi.withTransport(f.server.url("/").toString(), cookies, "native-free-base-fixture", f.transport)
        private val session = AccountSession(f.wallet, f.server.url("/").toString().trimEnd('/'), game.sessionToken()).also(holder::replace)
        val api = SessionApiClient(game, session.token, ApiRouting())
        val store = FreeBasePurchaseStore(disk, StarterIdentity(session.origin, "devnet", f.wallet))
        var directory: BaseDirectory? = null
        var selected: String? = f.sourceBaseId
        var allowed = true
        val repository = FreeBasePurchaseRepository(session, holder, api, store, { selected }, { 0L }, { directory }, {
            assertEquals(f.wallet, api.get("/me").getValue("wallet").jsonPrimitive.content)
            directory = BaseDirectory.from(api.get("/bases"))
        }, { allowed })
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
        val sourceBaseId = setup.getValue("sourceBaseId").jsonPrimitive.content
        val costShards = setup.getValue("costShards").jsonPrimitive.content
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
                        val journal = active?.store?.read()?.operation
                        posts += buildJsonObject {
                            put("body", Json.parseToJsonElement(body)); put("status", response.getValue("status"))
                            put("journal", buildJsonObject { put("attempted", journal?.attemptRevision != null) })
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
        fun inspect(key: String) = bridge.command(buildJsonObject { put("op", "inspect"); put("key", key) })
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
        private val script = root.resolve("apps/api/test/fixtures/nativeFreeBaseApiFixture.ts").also { require(it.isFile) }
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
        companion object { const val PREFIX = "NATIVE_FREE_BASE_FIXTURE:" }
    }
}
