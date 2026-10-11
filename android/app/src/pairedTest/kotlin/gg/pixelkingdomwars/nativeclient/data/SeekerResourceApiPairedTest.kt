package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.seekerresources.*
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
class SeekerResourceApiPairedTest {
    @Test fun `actual native claim creates conserved stock and archives only after hydration`() = Fixture().use { f -> runBlocking {
        val c = f.client(); c.repository.refresh(); assertTrue(f.posts.isEmpty())
        val row = c.repository.state.value.view!!.rows.first(); c.repository.reviewClaim(row)
        c.repository.confirm(c.repository.state.value.review!!)
        val receipt = requireNotNull(c.store.read().operation?.receipt); assertPosting(f, receipt)
        assertEquals(1, f.posts.size); assertTrue(f.posts.single().getValue("journal").jsonObject.getValue("attempted").jsonPrimitive.boolean)
        c.repository.finish(); assertNull(c.store.read().operation); assertEquals(1, c.hydrations)
        assertEquals(receipt, c.store.read().archives.single().operation.receipt)
    } }
    @Test fun `lost accepted reply recovers over HTTPS after API restart and pause without another POST`() = Fixture().use { f -> runBlocking {
        val c = f.client(); c.repository.refresh(); c.repository.reviewClaim(c.repository.state.value.view!!.rows.first())
        f.loseNextPostResponse = true; assertTrue(runCatching { c.repository.confirm(c.repository.state.value.review!!) }.isFailure)
        assertNull(c.store.read().operation!!.receipt); assertEquals(1, f.posts.size)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovered = f.client(c.disk); recovered.selected = null; recovered.allowed = false; recovered.repository.refresh()
        val receipt = requireNotNull(recovered.store.read().operation?.receipt); assertPosting(f, receipt)
        assertFalse(recovered.repository.state.value.view!!.claimsEnabled); assertEquals(1, f.posts.size)
        recovered.selected = f.sourceBaseId; recovered.repository.finish(); assertEquals(1, f.posts.size)
        assertEquals(receipt, recovered.store.read().archives.single().operation.receipt)
    } }
    private fun assertPosting(f: Fixture, receipt: SeekerResourceClaimReceipt) {
        val inspection = f.inspect(receipt.idempotencyKey)
        assertEquals(listOf(receipt.id), inspection.getValue("claims").jsonArray.map { it.jsonPrimitive.content })
        val entries = inspection.getValue("entries").jsonArray.map { it.jsonObject }
        assertEquals(2, entries.size)
        assertEquals(receipt.quantity, entries.single { it.getValue("bucket").jsonPrimitive.content == "base_stock" }.getValue("delta").jsonPrimitive.content)
        assertEquals("-${receipt.quantity}", entries.single { it.getValue("bucket").jsonPrimitive.content == "island_pool" }.getValue("delta").jsonPrimitive.content)
        assertEquals(receipt.stockAfter, inspection.getValue("stock").jsonArray.single().jsonObject.getValue("available").jsonPrimitive.content)
    }
    private class Client(f: Fixture, val disk: MemoryStore) {
        private val holder = testHolder()
        private val cookies = SessionCookieJar(f.server.url("/"), MemoryStore()).apply {
            saveFromResponse(f.server.url("/"), listOf(requireNotNull(Cookie.parse(f.server.url("/"), f.cookie))))
        }
        private val game = GameApi.withTransport(f.server.url("/").toString(), cookies, "native-free-base-fixture", f.transport)
        private val session = AccountSession(f.wallet, f.server.url("/").toString().trimEnd('/'), game.sessionToken()).also(holder::replace)
        val api = SessionApiClient(game, session.token, ApiRouting())
        val store = SeekerResourceClaimStore(disk, StarterIdentity(session.origin, "devnet", f.wallet))
        var directory: BaseDirectory? = null
        var selected: String? = f.sourceBaseId
        var allowed = true
        var hydrations = 0
        val repository = SeekerResourceClaimsRepository(session, holder, api, store, { selected }, { 0L }, { directory }, {
            assertEquals(f.wallet, api.get("/me").getValue("wallet").jsonPrimitive.content)
            directory = BaseDirectory.from(api.get("/bases"))
        }, { guard ->
            guard(); val saved = requireNotNull(store.read().operation?.receipt)
            val stock = gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView.from(
                api.getOrdinaryCrafting("/ordinary-crafting", mapOf("baseId" to saved.baseId), guard))
            assertEquals(saved.stockAfter, stock.rawStock.single { it.resourceId == saved.resourceId }.available)
            assertEquals(saved.baseId, stock.baseId); assertEquals(f.wallet, stock.wallet); hydrations++; guard()
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
        private val script = root.resolve("apps/api/test/fixtures/nativeSeekerResourceApiFixture.ts").also { require(it.isFile) }
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
        companion object { const val PREFIX = "NATIVE_SEEKER_RESOURCE_FIXTURE:" }
    }
}
