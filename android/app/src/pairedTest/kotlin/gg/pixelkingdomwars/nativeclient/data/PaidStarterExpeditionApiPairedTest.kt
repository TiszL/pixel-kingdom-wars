package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testHolder
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
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Actual TLS GameApi/repository/journal against isolated Fastify and genuine fixture term/access decoders. */
class PaidStarterExpeditionApiPairedTest {
    @Test fun `lost committed paid departure recovers by original GET while paused then returns after coverage expiry and hydrates before archive`() = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repository.refresh(); first.repository.selectPaidRealm(0)
        val selected = requireNotNull(first.repository.state.value.paidView)
        assertEquals("none", selected.authorization); assertEquals("covered", selected.coverage.status)
        assertEquals("crownlands", first.repository.state.value.view!!.home!!.realmId)
        assertEquals("frostveil", selected.route.realmId)
        assertNull(first.store.read().operation); assertTrue(f.posts.isEmpty())
        first.repository.reviewPaidDeparture(0)
        val review = requireNotNull(first.repository.state.value.review); val original = review.command
        assertNull(original.route.access!!.observation); assertTrue(f.posts.isEmpty())
        f.loseNextPostResponse = true
        assertTrue(runCatching { first.repository.confirm(review) }.isFailure)
        assertEquals(1, f.posts.size); assertEquals(201, f.posts.single().getValue("status").jsonPrimitive.int)
        assertEquals(original.request.body(), f.posts.single().getValue("body")); assertTrue(f.posts.single().getValue("attempted").jsonPrimitive.boolean)
        assertNull(first.store.read().operation!!.proof)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovered = f.client(MemoryStore(first.disk.value)); recovered.allowed = false
        val gets = f.gets.size; recovered.repository.reviewSaved()
        assertEquals(listOf("/api${original.receiptPath}"), f.gets.drop(gets))
        val accepted = requireNotNull(recovered.store.read().operation!!.proof); val receipt = requireNotNull(accepted.receipt)
        assertEquals(original.request, receipt.request); assertEquals(f.wallet, receipt.route.access!!.observation!!.wallet)
        assertEquals(original.route, receipt.route.copy(access = StarterExpeditionAccess("paid_realm", 1)))
        assertNull(recovered.repository.state.value.review); assertEquals(1, f.posts.size)
        val advanced = f.bridge.command(buildJsonObject { put("op", "advance"); put("key", original.key) })
        assertTrue(advanced.getValue("afterCoverageExpiry").jsonPrimitive.boolean)
        recovered.repository.check(); val returned = requireNotNull(recovered.store.read().operation!!.proof)
        assertNotNull(returned.returned); assertEquals(receipt, returned.receipt)
        recovered.repository.finish(); assertNull(recovered.store.read().operation); assertEquals(1, recovered.hydrations)
        assertEquals(returned, recovered.store.read().archives.single().operation.proof)
        val inspected = f.inspect(original.key)
        assertEquals(1, inspected.getValue("departures").jsonPrimitive.int); assertEquals(1, inspected.getValue("returns").jsonPrimitive.int)
        assertEquals(1, inspected.getValue("posts").jsonPrimitive.int)
        assertEquals(0, inspected.getValue("inflight").jsonPrimitive.int)
        val entries = inspected.getValue("entries").jsonArray.map { it.jsonObject }
        assertEquals(3, entries.size)
        assertEquals(receipt.route.netQuantity, entries.single { it.getValue("bucket").jsonPrimitive.content == "base_stock" }.getValue("delta").jsonPrimitive.content)
        assertEquals(receipt.route.islandPoolQuantity, entries.single { it.getValue("bucket").jsonPrimitive.content == "island_pool" }.getValue("delta").jsonPrimitive.content)
        assertEquals("-${receipt.route.grossQuantity}", entries.single { it.getValue("bucket").jsonPrimitive.content == "issued" }.getValue("delta").jsonPrimitive.content)
        assertEquals(receipt.route.netQuantity, inspected.getValue("stock").jsonPrimitive.content)
        recovered.repository.checkArchived(original.key); assertEquals(returned, recovered.store.read().archives.single().operation.proof)
        assertEquals(1, f.posts.size)
    } }
    private class Client(f: Fixture, val disk: MemoryStore) {
        private val holder = testHolder()
        private val cookies = SessionCookieJar(f.server.url("/"), MemoryStore()).apply {
            saveFromResponse(f.server.url("/"), listOf(requireNotNull(Cookie.parse(f.server.url("/"), f.cookie))))
        }
        private val game = GameApi.withTransport(f.server.url("/").toString(), cookies, "native-paid-starter-fixture", f.transport)
        private val session = AccountSession(f.wallet, f.server.url("/").toString().trimEnd('/'), game.sessionToken()).also(holder::replace)
        private val api = SessionApiClient(game, session.token, ApiRouting())
        val store = StarterExpeditionStore(disk, StarterIdentity(session.origin, "devnet", f.wallet))
        private var directory: BaseDirectory? = null
        var allowed = true; var hydrations = 0
        val repository = StarterExpeditionRepository(session, holder, api, store, { f.baseId }, { 0L }, { directory }, {
            assertEquals(f.wallet, api.get("/me").getValue("wallet").jsonPrimitive.content)
            directory = BaseDirectory.from(api.get("/bases"))
        }, { guard ->
            val original = requireNotNull(store.read().operation!!.proof!!.receipt)
            val fresh = StarterExpeditionView.from(api.getStarterExpedition("/starter-expeditions", mapOf("baseId" to f.baseId), guard))
            assertEquals(f.wallet, fresh.wallet); assertEquals(f.baseId, fresh.baseId)
            assertEquals(original.route.netQuantity, fresh.rawStock.single { it.resourceId == original.route.resourceId }.available)
            hydrations++; guard()
        }, { allowed })
    }
    private class Fixture : AutoCloseable {
        private val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).retryOnConnectionFailure(false).build()
        val bridge = Bridge()
        private val setup = try { bridge.command(buildJsonObject { put("op", "start"); put("origin", server.url("/").toString().trimEnd('/')) }) }
        catch (error: Throwable) { runCatching { bridge.close() }; server.shutdown(); transport.dispatcher.executorService.shutdown(); throw error }
        val wallet = setup.getValue("wallet").jsonPrimitive.content; val cookie = setup.getValue("cookie").jsonPrimitive.content
        val baseId = setup.getValue("baseId").jsonPrimitive.content
        val posts = mutableListOf<JsonObject>(); val gets = mutableListOf<String>()
        @Volatile var loseNextPostResponse = false; @Volatile private var active: Client? = null
        init { server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                val response = try { bridge.command(buildJsonObject {
                    put("op", "request"); put("method", request.method); put("url", request.path)
                    put("headers", buildJsonObject { request.headers.names().forEach { put(it, request.getHeader(it)) } })
                    if (body.isNotEmpty()) put("body", body)
                }) } catch (e: Exception) { return MockResponse().setResponseCode(500).setBody(buildJsonObject {
                    putJsonObject("error") { put("code", "PAIRED_FIXTURE_ERROR"); put("message", e.message) }
                }.toString()) }
                if (request.method == "POST") {
                    posts += buildJsonObject { put("body", Json.parseToJsonElement(body)); put("status", response.getValue("status"))
                        put("attempted", active?.store?.read()?.operation?.attemptRevision != null) }
                    if (loseNextPostResponse) { loseNextPostResponse = false; return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
                } else gets += requireNotNull(request.path)
                return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int).setHeader("Content-Type", "application/json")
                    .setBody(response.getValue("body").jsonPrimitive.content)
            }
        } }
        fun client(disk: MemoryStore = MemoryStore()) = Client(this, disk).also { active = it }
        fun inspect(key: String) = bridge.command(buildJsonObject { put("op", "inspect"); put("key", key) })
        override fun close() { try { bridge.close() } finally { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() } }
    }
    /** No backend listener; only this process's private input controls fixture state. */
    private class Bridge : AutoCloseable {
        private val root = File(requireNotNull(System.getenv("PHASE_E_API_ROOT")))
        private val script = root.resolve("apps/api/test/fixtures/nativePaidStarterExpeditionApiFixture.ts").also { require(it.isFile) }
        private val process = ProcessBuilder("node", "--import", "tsx", script.absolutePath).directory(root.resolve("apps/api"))
            .redirectError(ProcessBuilder.Redirect.INHERIT).apply { environment()["NODE_ENV"] = "test"; environment()["PHASE_E_NATIVE_PAIRED"] = "1" }.start()
        private val input = process.outputStream.bufferedWriter(); private val output = process.inputStream.bufferedReader()
        private val reads = Executors.newSingleThreadExecutor()
        @Synchronized fun command(value: JsonObject): JsonObject {
            input.write(value.toString()); input.newLine(); input.flush()
            val line = reads.submit<String> { while (true) {
                val next = output.readLine() ?: error("Paid expedition fixture exited before reply")
                if (next.startsWith(PREFIX)) return@submit next.removePrefix(PREFIX)
            }; @Suppress("UNREACHABLE_CODE") error("unreachable") }.get(60, TimeUnit.SECONDS)
            return Json.parseToJsonElement(line).jsonObject.also { check(it["error"] == null) { "Paid expedition fixture failed: ${it["error"]}" } }
        }
        override fun close() { try { input.close(); check(process.waitFor(10, TimeUnit.SECONDS)); check(process.exitValue() == 0) }
            finally { process.destroyForcibly(); reads.shutdownNow(); output.close() } }
        companion object { const val PREFIX = "NATIVE_PAID_STARTER_FIXTURE:" }
    }
}
