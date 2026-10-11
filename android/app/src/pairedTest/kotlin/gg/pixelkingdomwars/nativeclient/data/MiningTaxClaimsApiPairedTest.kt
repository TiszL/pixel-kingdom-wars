package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.mining.*
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
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Actual private authenticated API + native crypto/journal, over local fixture-only evidence. */
class MiningTaxClaimsApiPairedTest {
    @Test fun `combined original approval survives lost replies and paused providerless offline archival`() = pair("combined")
    @Test fun `split setup pays no KEEP and above quote setup costs require a separate claim approval`() = pair("split")
    private fun pair(mode: String) = Fixture(mode).use { f -> runBlocking {
        val first = f.client(); first.repo.open(); f.losePrepare = true
        assertTrue(runCatching { first.repo.begin(f.p.round, f.p.spot, f.p.caps) }.isFailure)
        assertTrue(first.store.read().operation!!.prepareAttempted); assertNull(first.store.read().operation!!.preparation)
        assertEquals(1, f.posts.size); assertEquals(201, f.posts.single().getValue("status").jsonPrimitive.int)
        assertTrue(f.posts.single().getValue("attempted").jsonPrimitive.boolean)
        var current = f.client(MemoryStore(first.disk.value)); current.repo.open(); assertEquals(f.p, current.store.read().operation!!.preparation)
        val count = f.p.transactions.size
        if (count == 2) { assertTrue(runCatching { current.repo.review(1) }.isFailure); assertEquals(0, f.approvals) }
        for (ordinal in 0 until count) {
            current.repo.review(ordinal); current.repo.sign(ordinal)
            val saved = current.store.read().operation!!.transactions.single { it.ordinal == ordinal }.signed!!
            assertEquals(ordinal + 1, f.approvals); f.loseSubmit = true
            assertTrue(runCatching { current.repo.submit(ordinal) }.isFailure)
            assertTrue(current.store.read().operation!!.transactions.single { it.ordinal == ordinal }.submitAttempted)
            val post = f.posts.last(); assertTrue(post.getValue("attempted").jsonPrimitive.boolean); assertEquals(saved.wire, post.getValue("wire").jsonPrimitive.content)
            current = f.client(MemoryStore(current.disk.value)); current.repo.open()
            assertTrue(runCatching { current.repo.submit(ordinal) }.isFailure)
            f.bridge.command(buildJsonObject { put("op", "settle"); put("key", f.p.idempotencyKey); put("ordinal", ordinal); if (mode == "split" && ordinal == 0) put("setupFee", 6) })
            f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
            current = f.client(MemoryStore(current.disk.value), paused = true); current.repo.open(); assertFalse(current.walletAvailable)
            if (mode == "split" && ordinal == 0) {
                val op = current.store.read().operation!!; assertNotNull(op.setup); assertNull(op.settlement)
                assertEquals("6", op.setup!!.settlement!!.receipt.feeLamports)
                assertTrue(op.setup.settlement!!.receipt.feeLamports.toBigInteger() > f.p.transactions[0].feeLamports.toBigInteger())
                assertTrue(runCatching { current.repo.archive() }.isFailure)
                assertTrue(runCatching { current.repo.review(1) }.isFailure); assertEquals(1, f.approvals)
                f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", false) })
                current = f.client(MemoryStore(current.disk.value)); current.repo.open()
            }
        }
        assertNotNull(current.store.read().operation!!.settlement); current.repo.archive(); assertNull(current.store.read().operation)
        val archived = requireNotNull(current.store.archived(f.p.idempotencyKey)); assertEquals(count, archived.operation.transactions.size)
        val inspected = f.bridge.command(buildJsonObject { put("op", "inspect") })
        assertEquals(1, inspected.getValue("preparePosts").jsonPrimitive.int); assertEquals(count, inspected.getValue("submitPosts").jsonPrimitive.int)
        for (field in listOf("signatures", "sends")) assertEquals((0 until count).toList(), inspected.getValue(field).jsonArray.map { it.jsonPrimitive.int })
        for (field in listOf("wires", "receipts")) assertEquals((0 until count).toList(), inspected.getValue(field).jsonArray.map { it.jsonObject.getValue("ordinal").jsonPrimitive.int })
        assertEquals(count, f.approvals); assertEquals(count + 1, f.posts.size)
        f.offline = true; val requests = f.server.requestCount
        val offline = f.client(MemoryStore(current.disk.value), paused = true); offline.repo.open()
        assertEquals(archived, offline.repo.archived(f.p.idempotencyKey)); assertEquals(requests, f.server.requestCount)
    } }
    @Test fun `atomic failed packet preserves actual fee above consent cap through paused GET and explicit failed archive`() = failedPair("combined")
    @Test fun `split setup success and claim failure preserve separate setup spend and failed fee without retry`() = failedPair("split")
    private fun failedPair(mode: String) = Fixture(mode).use { f -> runBlocking {
        var current = f.client(); current.repo.open(); current.repo.begin(f.p.round, f.p.spot, f.p.caps)
        if (mode == "split") {
            current.repo.review(0); current.repo.sign(0); current.repo.submit(0)
            f.bridge.command(buildJsonObject { put("op", "settle"); put("key", f.p.idempotencyKey); put("ordinal", 0); put("setupFee", 6) })
            current.repo.recover(); assertEquals("6", current.store.read().operation!!.setup!!.settlement!!.receipt.feeLamports)
            assertTrue(runCatching { current.repo.archiveFailed() }.isFailure)
        }
        val ordinal = f.p.transactions.lastIndex
        current.repo.review(ordinal); current.repo.sign(ordinal); val signed = current.store.read().operation!!.transactions.last().signed!!
        f.loseSubmit = true; assertTrue(runCatching { current.repo.submit(ordinal) }.isFailure)
        assertTrue(current.store.read().operation!!.transactions.last().submitAttempted)
        assertEquals(signed.wire, f.posts.last().getValue("wire").jsonPrimitive.content)
        assertTrue(f.bridge.command(buildJsonObject { put("op", "fail"); put("key", f.p.idempotencyKey); put("ordinal", ordinal); put("fee", 20) }).getValue("verified").jsonPrimitive.boolean)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        current = f.client(MemoryStore(current.disk.value), paused = true); current.repo.recover()
        assertFalse(current.walletAvailable); val op = current.store.read().operation!!; val failure = requireNotNull(op.failure).failures.single().receipt
        assertEquals("20", failure.feeLamports); assertTrue(failure.feeLamports.toBigInteger() > f.p.caps.maxFeeLamports.toBigInteger())
        assertEquals("0", failure.paidKeepBaseUnits); assertEquals("0", failure.rentLamports); assertNull(op.settlement)
        assertTrue(op.failureObserved); assertTrue(runCatching { current.repo.submit(ordinal) }.isFailure)
        f.loseFailure = true; assertTrue(runCatching { current.repo.archiveFailed() }.isFailure); assertEquals(op, current.store.read().operation)
        val before = f.server.requestCount; current.repo.archiveFailed(); assertEquals(before + 1, f.server.requestCount)
        assertNull(current.store.read().operation); val archive = requireNotNull(current.repo.archived(f.p.idempotencyKey))
        assertEquals(op, archive.operation); assertEquals(f.p.transactions.size, archive.operation.transactions.size)
        if (mode == "split") { assertEquals("6", archive.operation.setup!!.settlement!!.receipt.feeLamports); assertEquals(op.setup, archive.operation.setup) }
        else assertNull(archive.operation.setup)
        val inspected = f.bridge.command(buildJsonObject { put("op", "inspect") }); val ordinals = f.p.transactions.indices.toList()
        assertEquals(1, inspected.getValue("preparePosts").jsonPrimitive.int); assertEquals(ordinals.size, inspected.getValue("submitPosts").jsonPrimitive.int)
        for (field in listOf("signatures", "sends")) assertEquals(ordinals, inspected.getValue(field).jsonArray.map { it.jsonPrimitive.int })
        assertEquals(ordinals, inspected.getValue("wires").jsonArray.map { it.jsonObject.getValue("ordinal").jsonPrimitive.int })
        assertEquals(if (mode == "split") listOf(0) else emptyList<Int>(), inspected.getValue("receipts").jsonArray.map { it.jsonObject.getValue("ordinal").jsonPrimitive.int })
        assertEquals(ordinals.size, f.approvals); assertEquals(ordinals.size + 1, f.posts.size)
        f.offline = true; val requests = f.server.requestCount; val offline = f.client(MemoryStore(current.disk.value), paused = true)
        offline.repo.open(); assertEquals(archive, offline.repo.archived(f.p.idempotencyKey)); assertEquals(requests, f.server.requestCount)
    } }
    @Test fun `linked split preparation survives a committed lost reply and adopts while paused without another signature`() = continuationPair(false)
    @Test fun `unexpired parent resumes only the same saved continuation intent after finalized height advances`() = continuationPair(true)
    private fun continuationPair(unexpired: Boolean) = Fixture("split", java.util.UUID.randomUUID().toString()).use { f -> runBlocking {
        var client = f.client(); client.repo.open(); client.repo.begin(f.p.round, f.p.spot, f.p.caps)
        client.repo.review(0); client.repo.sign(0); client.repo.submit(0)
        f.bridge.command(buildJsonObject { put("op", "settle"); put("key", f.p.idempotencyKey); put("ordinal", 0); put("setupFee", 6) })
        client.repo.recover(); val parent = client.store.read().operation!!
        assertEquals("6", parent.setup!!.settlement!!.receipt.feeLamports)
        val caps = MiningTaxClaimsCaps("10", "1000", "1010")
        f.advance(!unexpired); f.loseContinuation = !unexpired
        assertTrue(runCatching { client.repo.prepareContinuation(caps) }.isFailure)
        val pending = client.store.read().operation!!; val intent = pending.continuation!!
        assertTrue(intent.attempted); assertNull(intent.envelope)
        assertEquals(MiningTaxClaimsContinuationRequest(f.continuationKey!!, caps), intent.request)
        assertEquals(parent.transactions, pending.transactions); assertEquals(parent.setup, pending.setup)
        val post = f.posts.last(); assertTrue(post.getValue("attempted").jsonPrimitive.boolean)
        assertEquals(intent.request, MiningTaxClaimsContinuationRequest.from(Json.parseToJsonElement(post.getValue("body").jsonPrimitive.content).jsonObject))
        assertEquals(if (unexpired) 409 else 201, post.getValue("status").jsonPrimitive.int)
        client = f.client(MemoryStore(client.disk.value)); client.repo.open()
        assertEquals(1, f.bridge.command(buildJsonObject { put("op", "inspect") }).getValue("continuationPosts").jsonPrimitive.int)
        if (unexpired) {
            assertNull(client.store.read().operation!!.continuation!!.envelope)
            f.advance(true); client.repo.resumeContinuation()
            assertEquals(post.getValue("body"), f.posts.last().getValue("body"))
        }
        assertNotNull(client.store.read().operation!!.continuation!!.envelope)
        val counts = f.bridge.command(buildJsonObject { put("op", "inspect") })
        assertEquals(if (unexpired) 2 else 1, counts.getValue("continuationPosts").jsonPrimitive.int)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        client = f.client(MemoryStore(client.disk.value), paused = true); client.repo.open(); assertFalse(client.walletAvailable)
        client.repo.activateContinuation()
        val child = client.store.read().operation!!; assertEquals(f.continuationKey, child.request.idempotencyKey)
        assertEquals(caps, child.request.caps); assertTrue(child.transactions.isEmpty()); assertNull(child.setup); assertNull(child.settlement); assertNull(client.repo.state.value.review)
        val archived = client.repo.archived(f.p.idempotencyKey)!!.operation
        assertEquals(parent.transactions, archived.transactions); assertEquals(parent.setup, archived.setup)
        assertNull(archived.settlement); assertNull(archived.failure)
        assertEquals(child.preparation, archived.continuation!!.envelope!!.continuation!!.childPreparation)
        assertEquals(counts, f.bridge.command(buildJsonObject { put("op", "inspect") }))
        assertEquals(1, f.approvals)
        for (field in listOf("signatures", "sends")) assertEquals(listOf(0), counts.getValue(field).jsonArray.map { it.jsonPrimitive.int })
        assertEquals(1, counts.getValue("preparePosts").jsonPrimitive.int); assertEquals(1, counts.getValue("submitPosts").jsonPrimitive.int)
        assertTrue(runCatching { client.repo.sign(0) }.isFailure)
    } }
    private class Client(f: Fixture, val disk: MemoryStore, paused: Boolean) {
        val holder = testHolder()
        private val jar = SessionCookieJar(f.server.url("/"), MemoryStore()).apply { saveFromResponse(f.server.url("/"), listOf(Cookie.parse(f.server.url("/"), f.cookie)!!)) }
        private val game = GameApi.withTransport(f.server.url("/").toString(), jar, "native-tax-pair", f.http)
        val session = AccountSession(f.p.wallet, f.server.url("/").toString().trimEnd('/'), game.sessionToken()).also(holder::replace)
        val identity = StarterIdentity(session.origin, "devnet", session.wallet)
        val store = MiningTaxClaimsStore(disk, identity, f.trust, requireNotNull(miningTaxClaimsPolicy(f.catalogue)).signing())
        val walletAvailable = !paused
        private val external = if (paused) null else MiningTaxClaimsExternalSigner { prepared, chain, retain, guard ->
            guard(); assertEquals(SolanaCluster.DEVNET, chain)
            assertTrue(store.read().operation!!.transactions.single { it.ordinal == prepared.ordinal }.signingStarted); f.approvals++
            val reply = f.bridge.command(buildJsonObject { put("op", "sign"); put("key", f.p.idempotencyKey); put("ordinal", prepared.ordinal); put("unsigned", Base64.getEncoder().encodeToString(prepared.unsignedTransaction())) })
            prepared.verifySignedBase64(reply.getValue("wire").jsonPrimitive.content).also { retain(it); guard() }
        }
        private val wallet = MiningTaxClaimsWallet(session, holder, session.origin, SolanaCluster.DEVNET, { false }, { null }, external)
        private val app = MiningTaxClaimsAppPorts(session, holder, session.origin, SolanaCluster.DEVNET, game.miningTaxClaimsPort(identity, session.token),
            store, { if (paused) null else f.catalogue }, { !paused }, { MiningTaxClaimsLifecycle(true, true, 0, !paused, !paused, "fixture-content", false) }, wallet,
            object : MiningClaimsRpcReads { override suspend fun genesisHash() = f.trust.genesisHash; override suspend fun finalizedBlockHeight() = f.height },
            f.gate, { System.nanoTime() / 1_000_000 }, { if (paused) null else f.trust })
        private val ports = object : MiningTaxClaimsPorts by app { override fun key() = if (f.continuationKey != null && f.keyCalls++ > 0) f.continuationKey else f.p.idempotencyKey }
        val repo = MiningTaxClaimsRepository(store, ports)
    }
    private class Fixture(mode: String, val continuationKey: String? = null) : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build(); private val ca = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val http = OkHttpClient.Builder().sslSocketFactory(ca.sslSocketFactory(), ca.trustManager).build()
        val gate = MiningClaimsRpcGate(); val bridge = Bridge()
        private val setup = try { bridge.command(buildJsonObject { put("op", "start"); put("mode", mode); put("origin", server.url("/").toString().trimEnd('/')); continuationKey?.let { put("continuationKey", it) } }) }
            catch (error: Throwable) { runCatching { bridge.close() }; server.shutdown(); http.dispatcher.executorService.shutdown(); gate.close(); throw error }
        val p = MiningTaxClaimsPreparation.from(setup.getValue("preparation").jsonObject)
        val cookie = setup.getValue("cookie").jsonPrimitive.content; var height = setup.getValue("blockHeight").jsonPrimitive.long
        val catalogue = setup.getValue("catalogue").jsonObject
        val trust = setup.getValue("trust").jsonObject.let { v -> fun t(k: String) = v.getValue(k).jsonPrimitive.content
            MiningTaxClaimsSigningTrust(t("genesisHash"), t("programId"), t("configAddress"), t("keepMint"), t("reserveOwner"), v.getValue("reviewedDeploymentSlot").jsonPrimitive.long, t("reviewedProgramDataSha256")) }
        val posts = mutableListOf<JsonObject>(); var approvals = 0; var keyCalls = 0
        @Volatile var offline = false; @Volatile var losePrepare = false; @Volatile var loseSubmit = false; @Volatile var loseFailure = false; @Volatile var loseContinuation = false; @Volatile private var active: Client? = null
        init { server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (offline) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                val body = request.body.readUtf8(); val op = if (request.method == "POST") runBlocking { active?.store?.read()?.operation } else null
                val reply = try { bridge.command(buildJsonObject { put("op", "request"); put("method", request.method); put("url", request.path)
                    put("headers", buildJsonObject { request.headers.names().forEach { put(it, request.getHeader(it)) } }); if (body.isNotEmpty()) put("body", body) }) }
                catch (error: Exception) { return MockResponse().setResponseCode(500).setBody(buildJsonObject {
                    putJsonObject("error") { put("code", "PAIRED_FIXTURE_ERROR"); put("message", error.message) }
                }.toString()) }
                if (request.method == "GET" && request.path!!.contains("/failures/by-key/") && loseFailure) {
                    loseFailure = false; return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                }
                if (request.method == "POST") {
                    val continuing = request.path!!.contains("/continue/"); val submitting = request.path!!.endsWith("/submit"); val wire = if (submitting) Json.parseToJsonElement(body).jsonObject.getValue("signedTransaction").jsonPrimitive.content else null
                    posts += buildJsonObject { put("status", reply.getValue("status")); put("path", request.path); put("wire", wire); put("body", body)
                        put("attempted", if (continuing) op?.continuation?.attempted == true else if (submitting) op?.transactions?.any { it.signed?.wire == wire && it.submitAttempted } == true else op?.prepareAttempted == true) }
                    if (continuing && loseContinuation) { loseContinuation = false; return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
                    if (submitting && loseSubmit || !submitting && losePrepare) { if (submitting) loseSubmit = false else losePrepare = false; return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
                }
                return MockResponse().setResponseCode(reply.getValue("status").jsonPrimitive.int).setHeader("Content-Type", "application/json").setBody(reply.getValue("body").jsonPrimitive.content)
            }
        } }
        fun advance(expired: Boolean) { height = bridge.command(buildJsonObject { put("op", "advance"); put("expired", expired) }).getValue("blockHeight").jsonPrimitive.long }
        fun client(disk: MemoryStore = MemoryStore(), paused: Boolean = false) = Client(this, disk, paused).also { active = it }
        override fun close() { try { bridge.close() } finally { gate.close(); server.shutdown(); http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() } }
    }
    private class Bridge : AutoCloseable {
        private val root = File(requireNotNull(System.getenv("PHASE_E_API_ROOT")))
        private val script = root.resolve("apps/api/test/fixtures/nativeMiningTaxClaimsApiFixture.ts").also { require(it.isFile) }
        private val process = ProcessBuilder("node", "--import", "tsx", script.absolutePath).directory(root.resolve("apps/api"))
            .redirectError(ProcessBuilder.Redirect.INHERIT).apply { environment()["NODE_ENV"] = "test"; environment()["PHASE_E_NATIVE_PAIRED"] = "1" }.start()
        private val input = process.outputStream.bufferedWriter(); private val output = process.inputStream.bufferedReader(); private val reads = Executors.newSingleThreadExecutor()
        @Synchronized fun command(value: JsonObject): JsonObject {
            input.write(value.toString()); input.newLine(); input.flush()
            val line = reads.submit<String> { while (true) { val next = output.readLine() ?: error("Native tax fixture exited"); if (next.startsWith(PREFIX)) return@submit next.removePrefix(PREFIX) }; @Suppress("UNREACHABLE_CODE") error("unreachable") }.get(60, TimeUnit.SECONDS)
            return Json.parseToJsonElement(line).jsonObject.also { check(it["error"] == null) { "Native tax fixture failed: ${it["error"]}" } }
        }
        override fun close() { try { input.close(); check(process.waitFor(10, TimeUnit.SECONDS)); check(process.exitValue() == 0) } finally { process.destroyForcibly(); reads.shutdownNow(); output.close() } }
        companion object { const val PREFIX = "NATIVE_MINING_TAX_FIXTURE:" }
    }
}
