package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimsProtocolPolicy
import gg.pixelkingdomwars.nativeclient.mining.MiningClaimView
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

/** Actual repository + HTTPS/authenticated API, with generated sign-only fixture keys. */
class MiningClaimsCumulativeApiPairedTest {
    @Test fun `native claims only the next funded delta and preserves both receipts through lost replies and paused restart`() = Fixture().use { f -> runBlocking {
        val first = f.client()
        // Recover a known original key from the prior device; GET supplies all
        // authoritative preparation/receipt fields. No signed bytes are invented.
        first.store.begin(first.store.read(), f.oldKey, f.policy); first.store.prepareAttempt(first.store.read())
        first.repo.open()
        val oldOperation = requireNotNull(first.store.read().operation)
        val oldPreparation = requireNotNull(oldOperation.preparation); val oldReceipt = requireNotNull(oldOperation.claim)
        assertEquals("1", oldPreparation.rootSequence)
        assertEquals(f.oldClaimId, oldPreparation.claimId)
        assertEquals(f.oldSignature, oldReceipt.signature)
        assertEquals(f.oldPayment, oldReceipt.settledBaseUnits)
        assertNull(oldOperation.signed); assertFalse(oldOperation.signingStarted)
        first.repo.finish(); val oldArchive = first.store.read().archives.single()
        assertTrue(f.posts.isEmpty()); assertEquals(0, f.approvals)
        assertEquals("2", first.repo.state.value.status!!.rootSequence)
        val delta = requireNotNull(first.repo.state.value.status!!.claimableBaseUnits).toBigInteger()
        assertTrue(delta.signum() > 0)
        assertEquals(f.oldPayment, first.repo.state.value.status!!.claimedBaseUnits)
        f.losePrepare = true; assertTrue(runCatching { first.repo.begin() }.isFailure)
        assertTrue(first.store.read().operation!!.prepareAttempted); assertNull(first.store.read().operation!!.preparation)
        assertEquals(1, f.posts.size); assertEquals(201, f.posts.single().getValue("status").jsonPrimitive.int)
        val second = f.client(MemoryStore(first.disk.value)); second.repo.open()
        val p = requireNotNull(second.store.read().operation!!.preparation)
        assertEquals("2", p.rootSequence); assertFalse(p.needsAta); assertFalse(p.needsMinerRecords)
        assertEquals("0", p.fees.rentLamports); assertEquals("claim", p.transactions.single().kind)
        assertEquals(f.oldPayment.toBigInteger() + delta, p.leaf.cumulativeKeepBaseUnits.toBigInteger())
        assertEquals(oldArchive, second.store.read().archives.single())
        assertEquals(0, f.approvals); second.repo.review(); assertEquals(0, f.approvals)
        second.repo.sign(); val signed = requireNotNull(second.store.read().operation!!.signed)
        assertEquals(1, f.approvals); assertEquals(1, f.posts.size)
        assertEquals(0, f.inspect().getValue("sends").jsonPrimitive.int)
        f.loseSubmit = true; assertTrue(runCatching { second.repo.submit() }.isFailure)
        assertTrue(second.store.read().operation!!.submitAttempted); assertEquals(signed, second.store.read().operation!!.signed)
        assertEquals(2, f.posts.size)
        assertTrue(f.posts[0].getValue("prepareAttempted").jsonPrimitive.boolean)
        assertTrue(f.posts[1].getValue("submitAttempted").jsonPrimitive.boolean)
        assertEquals(signed.wire, f.posts[1].getValue("wire").jsonPrimitive.content)
        val before = f.inspect(); assertEquals(1, before.getValue("sends").jsonPrimitive.int)
        assertEquals(1, before.getValue("receipts").jsonArray.size) // Only the old payment is finalized.
        val third = f.client(MemoryStore(second.disk.value)); third.repo.open()
        assertEquals("retained", third.store.read().operation!!.claim!!.state)
        assertNull(third.store.read().operation!!.claim!!.settledBaseUnits)
        assertTrue(runCatching { third.repo.finish() }.isFailure)
        assertTrue(runCatching { third.repo.submit() }.isFailure); assertEquals(2, f.posts.size)
        f.bridge.command(buildJsonObject { put("op", "settle"); put("claimId", p.claimId) })
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovery = f.client(MemoryStore(third.disk.value), paused = true); recovery.repo.open()
        val paid = requireNotNull(recovery.store.read().operation!!.claim)
        val paidAmount = requireNotNull(paid.settledBaseUnits).toBigInteger()
        assertEquals("settled", paid.state); assertEquals(delta, paidAmount)
        assertTrue(paidAmount < p.leaf.cumulativeKeepBaseUnits.toBigInteger())
        recovery.repo.finish(); assertNull(recovery.store.read().operation)
        val archives = recovery.store.read().archives; assertEquals(2, archives.size)
        assertEquals(oldArchive, archives[0]); assertEquals(signed, archives[1].signed)
        assertEquals(signed.signature, archives[1].claim!!.signature)
        val oldGet = recovery.api.getMiningClaim("/claims/mining/${f.oldClaimId}", {}) { raw ->
            val observed = MiningClaimView.from(raw)
            assertEquals(oldArchive.claim!!.copy(serverNow = observed.serverNow), observed)
        }
        assertEquals(f.oldSignature, oldGet.getValue("signature").jsonPrimitive.content)
        assertEquals(f.oldPayment, oldGet.getValue("settledBaseUnits").jsonPrimitive.content)
        val after = f.inspect()
        assertTrue(after.getValue("oldReceiptUnchanged").jsonPrimitive.boolean)
        assertEquals(delta, after.getValue("payment").jsonPrimitive.content.toBigInteger())
        assertEquals(f.oldPayment.toBigInteger() + delta, after.getValue("cumulative").jsonPrimitive.content.toBigInteger())
        assertEquals("0", after.getValue("setupRent").jsonPrimitive.content)
        assertEquals(2, after.getValue("receipts").jsonArray.size); assertEquals(2, after.getValue("wires").jsonArray.size)
        assertEquals(1, after.getValue("preparePosts").jsonPrimitive.int); assertEquals(1, after.getValue("submitPosts").jsonPrimitive.int)
        assertEquals(1, after.getValue("approvals").jsonPrimitive.int); assertEquals(1, after.getValue("sends").jsonPrimitive.int)
        assertEquals(1, f.approvals); assertEquals(2, f.posts.size)
    } }
    private class Client(f: Fixture, val disk: MemoryStore, paused: Boolean) {
        val holder = testHolder()
        private val cookies = SessionCookieJar(f.server.url("/"), MemoryStore()).apply {
            saveFromResponse(f.server.url("/"), listOf(requireNotNull(Cookie.parse(f.server.url("/"), f.cookie))))
        }
        val game = GameApi.withTransport(f.server.url("/").toString(), cookies, "native-cumulative-mining-fixture", f.transport)
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
        val oldKey = setup.getValue("oldKey").jsonPrimitive.content
        val oldClaimId = setup.getValue("oldClaimId").jsonPrimitive.content
        val oldSignature = setup.getValue("oldSignature").jsonPrimitive.content
        val oldPayment = setup.getValue("oldPayment").jsonPrimitive.content
        val policy = setup.getValue("policy").jsonObject.let { p -> MiningClaimsProtocolPolicy(
            p.getValue("tokenDecimals").jsonPrimitive.int, p.getValue("quoteVersion").jsonPrimitive.int, p.getValue("quoteTtlSec").jsonPrimitive.long) }
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
        private val script = root.resolve("apps/api/test/fixtures/nativeCumulativeMiningClaimsApiFixture.ts").also { require(it.isFile) }
        private val process = ProcessBuilder("node", "--import", "tsx", script.absolutePath).directory(root.resolve("apps/api"))
            .redirectError(ProcessBuilder.Redirect.INHERIT).apply { environment()["NODE_ENV"] = "test"; environment()["PHASE_E_NATIVE_PAIRED"] = "1" }.start()
        private val input = process.outputStream.bufferedWriter(); private val output = process.inputStream.bufferedReader()
        private val reads = Executors.newSingleThreadExecutor()
        @Synchronized fun command(value: JsonObject): JsonObject {
            input.write(value.toString()); input.newLine(); input.flush()
            val line = reads.submit<String> {
                while (true) { val next = output.readLine() ?: error("Native mining fixture exited"); if (next.startsWith(PREFIX)) return@submit next.removePrefix(PREFIX) }
                @Suppress("UNREACHABLE_CODE") error("unreachable")
            }.get(if (value["op"]?.jsonPrimitive?.content == "start") 180 else 60, TimeUnit.SECONDS)
            return Json.parseToJsonElement(line).jsonObject.also { check(it["error"] == null) { "Native mining fixture failed: ${it["error"]}" } }
        }
        override fun close() { try { input.close(); check(process.waitFor(10, TimeUnit.SECONDS)); check(process.exitValue() == 0) }
            finally { process.destroyForcibly(); reads.shutdownNow(); output.close() } }
        companion object { const val PREFIX = "NATIVE_CUMULATIVE_MINING_FIXTURE:" }
    }
}
