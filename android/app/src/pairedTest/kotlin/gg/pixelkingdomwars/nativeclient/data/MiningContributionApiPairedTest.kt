package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.model.BaseCapabilities
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

/** Real native HTTPS transport + authenticated Fastify + disposable SQL custody. */
class MiningContributionApiPairedTest {
    @Test fun `ordinary mixed basket reserves exact stock with durable consent and retained free allowance`() = Fixture().use { f -> runBlocking {
        val c=f.client(); c.repository.refresh()
        assertEquals(20, c.repository.state.value.view!!.resources.size)
        assertEquals("20000", c.repository.state.value.view!!.remainingValue)
        c.repository.reviewStart(listOf(MiningContributionLine("shards","100"),MiningContributionLine("frost_quartz","2")))
        val review=requireNotNull(c.repository.state.value.review)
        c.repository.confirm(review)
        val original=requireNotNull(c.store.read().operation)
        assertEquals("300", original.proof!!.receipt!!.totalValue)
        assertEquals(review.command.request.body(),f.posts.single().getValue("body"))
        assertTrue(f.posts.single().getValue("journal").jsonObject.getValue("attempted").jsonPrimitive.boolean)
        val inspection=f.inspect(review.command.key)
        assertEquals(1,inspection.getValue("receipts").jsonArray.size)
        assertEquals("29900",inspection.getValue("shards").jsonPrimitive.content)
        val quartz=inspection.getValue("raw").jsonArray.single { it.jsonObject.getValue("resource_id").jsonPrimitive.content=="frost_quartz" }.jsonObject
        assertEquals("998",quartz.getValue("available").jsonPrimitive.content)
        assertEquals("2",quartz.getValue("mining_pending").jsonPrimitive.content)
        c.repository.finish(); assertNull(c.store.read().operation)
        assertEquals("19700",c.repository.state.value.view!!.remainingValue)
        c.repository.checkArchived(review.command.key); assertEquals(1,f.posts.size)
    } }
    @Test fun `lost acceptance survives journal reload pause and transfer with only original receipt reads`() = Fixture().use { f -> runBlocking {
        val c=f.client(); c.repository.reviewStart(listOf(MiningContributionLine("frost_quartz","2")))
        val review=requireNotNull(c.repository.state.value.review)
        f.loseNextPostResponse=true
        assertTrue(runCatching { c.repository.confirm(review) }.isFailure)
        val saved=requireNotNull(c.store.read().operation)
        assertNotNull(saved.attemptRevision); assertNull(saved.proof)
        f.bridge.command(buildJsonObject { put("op","pause");put("paused",true) })
        f.bridge.command(buildJsonObject { put("op","transfer") })
        val recovered=f.client(MemoryStore(c.disk.value)); recovered.selected=null;recovered.allowed=false
        recovered.repository.refresh()
        val proof=requireNotNull(recovered.store.read().operation!!.proof)
        assertEquals("accepted",proof.status);assertEquals(f.wallet,proof.wallet)
        assertEquals("200",proof.receipt!!.totalValue)
        recovered.repository.finish(); recovered.repository.checkArchived(review.command.key)
        assertEquals(MiningContributionHydration.ORIGINAL_BASE_UNAVAILABLE,recovered.repository.state.value.hydration)
        assertEquals(1,f.posts.size);assertEquals(1,f.inspect(review.command.key).getValue("receipts").jsonArray.size)
    } }
    @Test fun `deeded pool admits beyond free allowance while free pool remains capped`() = Fixture().use { f -> runBlocking {
        val c=f.client(); val lines=listOf(MiningContributionLine("frost_quartz","201"))
        assertTrue(runCatching { c.repository.reviewStart(lines) }.isFailure)
        assertTrue(f.posts.isEmpty());assertNull(c.store.read().operation)
        f.bridge.command(buildJsonObject { put("op","deed") })
        c.repository.reviewStart(lines)
        val review=requireNotNull(c.repository.state.value.review)
        assertEquals("deed",review.view.pool);assertNull(review.view.dailyCapValue)
        c.repository.confirm(review)
        assertEquals("20100",c.store.read().operation!!.proof!!.receipt!!.totalValue)
        assertEquals(1,f.posts.size)
    } }
    @Test fun `UTC rollover refuses old reviewed basket before sending any command`() = Fixture().use { f -> runBlocking {
        val c=f.client();c.repository.reviewStart(listOf(MiningContributionLine("frost_quartz","2")))
        val review=requireNotNull(c.repository.state.value.review)
        f.bridge.command(buildJsonObject { put("op","day");put("offsetDays",1) })
        assertTrue(runCatching { c.repository.confirm(review) }.isFailure)
        assertTrue(f.posts.isEmpty());assertEquals(review.command,c.store.read().operation!!.command)
        assertNull(c.store.read().operation!!.attemptRevision)
        assertTrue(f.inspect(review.command.key).getValue("receipts").jsonArray.isEmpty())
    } }
    private class Client(private val f: Fixture, val disk: MemoryStore) {
        private val holder=testHolder()
        private val cookies=SessionCookieJar(f.server.url("/"),MemoryStore()).apply {
            saveFromResponse(f.server.url("/"),listOf(requireNotNull(Cookie.parse(f.server.url("/"),f.cookie))))
        }
        private val game=GameApi.withTransport(f.server.url("/").toString(),cookies,"native-mining-fixture",f.transport)
        private val session=AccountSession(f.wallet,f.server.url("/").toString().trimEnd('/'),game.sessionToken()).also(holder::replace)
        val api=SessionApiClient(game,session.token,ApiRouting())
        val store=MiningContributionStore(disk,MiningContributionIdentity(session.origin,"devnet",f.wallet))
        var selected:String?=f.baseId
        var allowed=true
        // Host selection is seeded; all mining inventory, admission and proof come from the real API.
        private fun directory()=BaseDirectory(true,capabilities=BaseCapabilities(true,true),bases=if(selected==null) emptyList() else listOf(BaseSummary(f.baseId,"active",slot=1)))
        val repository=MiningContributionRepository(session,holder,api,store,{selected},{0L},{directory()},{},{ guard -> guard() },{allowed})
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
        val baseId = setup.getValue("baseId").jsonPrimitive.content
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
        private val script = root.resolve("apps/api/test/fixtures/miningContributionApiFixture.ts").also { require(it.isFile) }
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
        companion object { const val PREFIX = "MINING_CONTRIBUTION_FIXTURE:" }
    }
}
