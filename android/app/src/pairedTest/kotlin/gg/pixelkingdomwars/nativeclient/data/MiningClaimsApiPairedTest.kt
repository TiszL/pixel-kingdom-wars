package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.File
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Actual GameApi HTTPS, encrypted-journal serialization and sign-only adapter,
 * connected to the real restricted Fastify runtime through a private test pipe. */
class MiningClaimsApiPairedTest {
    @Test fun `native wallet claim survives both lost responses and archives only independently verified payment after paused restart`() = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repo.open(); f.losePrepare = true
        assertTrue(runCatching { first.repo.begin() }.isFailure)
        assertTrue(first.store.read().operation!!.prepareAttempted); assertNull(first.store.read().operation!!.preparation)
        assertEquals(1, f.posts.size); assertEquals(201, f.posts.single().getValue("status").jsonPrimitive.int)
        val second = f.client(MemoryStore(first.disk.value)); second.repo.open()
        val p = requireNotNull(second.store.read().operation!!.preparation)
        second.repo.review(); second.repo.sign()
        val signed = requireNotNull(second.store.read().operation!!.signed)
        assertEquals(1, f.approvals); assertEquals(1, f.posts.size)
        f.loseSubmit = true; assertTrue(runCatching { second.repo.submit() }.isFailure)
        assertTrue(second.store.read().operation!!.submitAttempted); assertEquals(signed, second.store.read().operation!!.signed)
        assertEquals(2, f.posts.size)
        assertTrue(f.posts[0].getValue("prepareAttempted").jsonPrimitive.boolean)
        assertTrue(f.posts[1].getValue("submitAttempted").jsonPrimitive.boolean)
        assertEquals(signed.wire, f.posts[1].getValue("wire").jsonPrimitive.content)
        val before = f.inspect(); assertEquals(1, before.getValue("sends").jsonPrimitive.int); assertTrue(before.getValue("receipts").jsonArray.isEmpty())
        val third = f.client(MemoryStore(second.disk.value)); third.repo.open()
        assertEquals("retained", third.store.read().operation!!.claim!!.state)
        assertTrue(runCatching { third.repo.submit() }.isFailure); assertEquals(2, f.posts.size)
        f.bridge.command(buildJsonObject { put("op", "settle"); put("claimId", p.claimId) })
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovery = f.client(MemoryStore(third.disk.value), paused = true); recovery.repo.open()
        assertEquals("settled", recovery.store.read().operation!!.claim!!.state)
        recovery.repo.finish(); assertNull(recovery.store.read().operation)
        val archive = recovery.store.read().archives.single()
        val after = f.inspect()
        assertEquals(signed, archive.signed); assertEquals(signed.signature, archive.claim!!.signature)
        assertEquals(after.getValue("payment").jsonPrimitive.content, archive.claim!!.settledBaseUnits)
        assertEquals(1, after.getValue("receipts").jsonArray.size); assertEquals(1, after.getValue("wires").jsonArray.size)
        assertEquals(1, after.getValue("preparePosts").jsonPrimitive.int); assertEquals(1, after.getValue("submitPosts").jsonPrimitive.int)
        assertEquals(1, after.getValue("signatures").jsonPrimitive.int); assertEquals(1, after.getValue("sends").jsonPrimitive.int)
        assertEquals(1, f.approvals); assertEquals(2, f.posts.size)
    } }
    @Test fun `native verified failure archives after paused restart and fresh preparation cannot reuse its signature`() = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repo.open(); first.repo.begin(); first.repo.review(); first.repo.sign(); first.repo.submit()
        val original = requireNotNull(first.store.read().operation); val prepared = requireNotNull(original.preparation); val signed = requireNotNull(original.signed)
        assertEquals("retained", original.claim!!.state); assertTrue(runCatching { first.repo.archiveFailed() }.isFailure)
        f.bridge.command(buildJsonObject { put("op", "fail"); put("claimId", prepared.claimId) })
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val paused = f.client(MemoryStore(first.disk.value), paused = true); paused.repo.open()
        assertEquals("failed", paused.store.read().operation!!.claim!!.state)
        assertNull(paused.store.read().operation!!.claim!!.settledBaseUnits)
        assertTrue(runCatching { paused.repo.sign() }.isFailure); assertTrue(runCatching { paused.repo.submit() }.isFailure)
        paused.repo.archiveFailed(); assertNull(paused.store.read().operation)
        val archived = paused.store.read().archives.single(); assertEquals(signed, archived.signed)
        assertEquals("failed", archived.claim!!.landing); assertEquals(signed.signature, archived.claim!!.signature)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", false) })
        val retry = f.client(MemoryStore(paused.disk.value)); retry.repo.open()
        assertTrue(runCatching { retry.repo.begin() }.isFailure)
        assertEquals("CLAIM_BLOCKHASH_REUSED", retry.store.read().operation!!.prepareRefusal!!.code)
        assertNull(retry.store.read().operation!!.preparation)
        retry.repo.archiveRefusal(); assertNull(retry.store.read().operation)
        val freshBlock = f.bridge.command(buildJsonObject { put("op", "freshBlockhash") }).getValue("blockhash").jsonPrimitive.content
        retry.repo.begin(); val fresh = requireNotNull(retry.store.read().operation!!.preparation)
        assertNotEquals(prepared.claimId, fresh.claimId); assertEquals(freshBlock, fresh.transactions.single().blockhash)
        assertEquals(2, retry.store.read().archives.size); assertNull(retry.store.read().operation!!.signed)
        val after = f.inspect(); assertEquals(1, after.getValue("failures").jsonArray.size); assertTrue(after.getValue("receipts").jsonArray.isEmpty())
        assertEquals(1, after.getValue("wires").jsonArray.size); assertEquals(1, after.getValue("sends").jsonPrimitive.int)
        assertEquals(3, after.getValue("preparePosts").jsonPrimitive.int); assertEquals(1, after.getValue("submitPosts").jsonPrimitive.int)
        assertEquals(1, f.approvals); assertEquals(1, after.getValue("signatures").jsonPrimitive.int)
    } }
    private class Client(f: Fixture, val disk: MemoryStore, paused: Boolean) {
        val holder = testHolder()
        private val cookies = SessionCookieJar(f.server.url("/"), MemoryStore()).apply {
            saveFromResponse(f.server.url("/"), listOf(requireNotNull(Cookie.parse(f.server.url("/"), f.cookie))))
        }
        val game = GameApi.withTransport(f.server.url("/").toString(), cookies, "native-mining-fixture", f.transport)
        val session = AccountSession(f.wallet, f.server.url("/").toString().trimEnd('/'), game.sessionToken()).also(holder::replace)
        val api = SessionApiClient(game, session.token, ApiRouting())
        val store = MiningClaimsStore(disk, StarterIdentity(session.origin, "devnet", f.wallet))
        private val wallet = MiningClaimsWallet(session, holder, session.origin, SolanaCluster.DEVNET, { false }, { null },
            MiningClaimsExternalSigner { prepared, cluster, onSigned, guard ->
                assertEquals(SolanaCluster.DEVNET, cluster); guard(); assertTrue(store.read().operation!!.signingStarted)
                f.approvals++
                val reply = f.bridge.command(buildJsonObject { put("op", "sign"); put("unsigned", Base64.getEncoder().encodeToString(prepared.unsignedTransaction())) })
                val signed = prepared.verifySignedBase64(reply.getValue("wire").jsonPrimitive.content)
                onSigned(signed); guard(); signed
            })
        val ports = MiningClaimsAppPorts(session, holder, api, store, { if (paused) null else f.catalogue }, { if (paused) null else f.pins },
            { MiningClaimsLifecycle(true, true, 0, !paused, !paused, "fixture-content", false) }, object : MiningClaimsRpcReads {
                override suspend fun genesisHash() = f.pins.genesisHash
                override suspend fun finalizedBlockHeight() = f.height
            }, f.rpcGate, { prepared, guard, retain -> wallet.sign(prepared, retain, guard); Unit }, { System.nanoTime() / 1_000_000 })
        val repo = MiningClaimsRepository(store, ports)
    }
    private class Fixture : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val rpcGate = MiningClaimsRpcGate(); val bridge = Bridge()
        private val setup = try { bridge.command(buildJsonObject { put("op", "start"); put("origin", server.url("/").toString().trimEnd('/')) }) }
        catch (error: Throwable) { runCatching { bridge.close() }; server.shutdown(); transport.dispatcher.executorService.shutdown(); rpcGate.close(); throw error }
        val wallet = setup.getValue("wallet").jsonPrimitive.content; val cookie = setup.getValue("cookie").jsonPrimitive.content
        val height = setup.getValue("blockHeight").jsonPrimitive.long
        val pins = setup.getValue("trust").jsonObject.let { p -> fun t(k: String) = p.getValue(k).jsonPrimitive.content
            MiningClaimSigningTrust(t("genesisHash"), t("programId"), t("configAddress"), t("keepMint"), t("reserveOwner")) }
        val catalogue = setup.getValue("policy").jsonObject.let { p -> buildJsonObject { put("constants", buildJsonObject {
            put("TOKEN", buildJsonObject { put("decimals", p.getValue("tokenDecimals")) })
            put("PHASE_E_MINING_CLAIM_QUOTE", buildJsonObject { put("version", p.getValue("quoteVersion")); put("ttlSec", p.getValue("quoteTtlSec")) })
        }) } }
        val posts = mutableListOf<JsonObject>(); var approvals = 0
        @Volatile var losePrepare = false; @Volatile var loseSubmit = false; @Volatile private var active: Client? = null
        init { server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                val journal = if (request.method == "POST") active?.store?.read()?.operation else null
                val result = try { bridge.command(buildJsonObject {
                    put("op", "request"); put("method", request.method); put("url", request.path)
                    put("headers", buildJsonObject { request.headers.names().forEach { put(it, request.getHeader(it)) } })
                    if (body.isNotEmpty()) put("body", body)
                }) } catch (error: Exception) { return MockResponse().setResponseCode(500).setBody(buildJsonObject {
                    put("error", buildJsonObject { put("code", "PAIRED_FIXTURE_ERROR"); put("message", error.message) }) }.toString()) }
                if (request.method == "POST") {
                    posts += buildJsonObject { put("path", request.path); put("status", result.getValue("status"))
                        put("prepareAttempted", journal?.prepareAttempted == true); put("submitAttempted", journal?.submitAttempted == true); put("wire", journal?.signed?.wire) }
                    if (request.path?.endsWith("/prepare") == true && losePrepare || request.path?.endsWith("/submit") == true && loseSubmit) {
                        if (request.path?.endsWith("/prepare") == true) losePrepare = false else loseSubmit = false
                        return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    }
                }
                return MockResponse().setResponseCode(result.getValue("status").jsonPrimitive.int)
                    .setHeader("Content-Type", "application/json").setBody(result.getValue("body").jsonPrimitive.content)
            }
        } }
        fun client(disk: MemoryStore = MemoryStore(), paused: Boolean = false) = Client(this, disk, paused).also { active = it }
        fun inspect() = bridge.command(buildJsonObject { put("op", "inspect") })
        override fun close() { try { bridge.close() } finally { rpcGate.close(); server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() } }
    }
    private class Bridge : AutoCloseable {
        private val root = File(requireNotNull(System.getenv("PHASE_E_API_ROOT")))
        private val script = root.resolve("apps/api/test/fixtures/nativeMiningClaimsApiFixture.ts").also { require(it.isFile) }
        private val process = ProcessBuilder("node", "--import", "tsx", script.absolutePath).directory(root.resolve("apps/api"))
            .redirectError(ProcessBuilder.Redirect.INHERIT).apply { environment()["NODE_ENV"] = "test"; environment()["PHASE_E_NATIVE_PAIRED"] = "1" }.start()
        private val input = process.outputStream.bufferedWriter(); private val output = process.inputStream.bufferedReader()
        private val reads = Executors.newSingleThreadExecutor()
        @Synchronized fun command(value: JsonObject): JsonObject {
            input.write(value.toString()); input.newLine(); input.flush()
            val line = reads.submit<String> {
                while (true) { val next = output.readLine() ?: error("Native mining fixture exited"); if (next.startsWith(PREFIX)) return@submit next.removePrefix(PREFIX) }
                @Suppress("UNREACHABLE_CODE") error("unreachable")
            }.get(60, TimeUnit.SECONDS)
            return Json.parseToJsonElement(line).jsonObject.also { check(it["error"] == null) { "Native mining fixture failed: ${it["error"]}" } }
        }
        override fun close() { try { input.close(); check(process.waitFor(10, TimeUnit.SECONDS)); check(process.exitValue() == 0) }
            finally { process.destroyForcibly(); reads.shutdownNow(); output.close() } }
        companion object { const val PREFIX = "NATIVE_MINING_CLAIMS_FIXTURE:" }
    }
}
