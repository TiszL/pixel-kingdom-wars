package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.realmsales.RealmSalePrepareRefusal
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
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

/** Actual authenticated HTTPS/API purchase, SecretStore journal serialization and sign-only wallet. */
class RealmSalesApiPairedTest {
    @Test fun `one native approval and relay survive lost replies then verified paid archive survives paused offline restart`() = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repo.open(); f.losePrepare = true
        assertTrue(runCatching { first.repo.begin(0, 0) }.isFailure)
        assertTrue(first.store.read().operation!!.prepareAttempted); assertNull(first.store.read().operation!!.preparation)
        assertEquals(1, f.posts.size); assertEquals(201, f.posts.single().getValue("status").jsonPrimitive.int)
        val second = f.client(MemoryStore(first.disk.value)); second.repo.open()
        val p = requireNotNull(second.store.read().operation!!.preparation)
        second.repo.review(); second.repo.sign(); val signed = requireNotNull(second.store.read().operation!!.signed)
        assertEquals(1, f.approvals); assertEquals(1, f.posts.size)
        f.loseSubmit = true; assertTrue(runCatching { second.repo.submit() }.isFailure)
        assertTrue(second.store.read().operation!!.submitAttempted); assertEquals(signed, second.store.read().operation!!.signed)
        assertEquals(2, f.posts.size); assertTrue(f.posts[0].getValue("prepareAttempted").jsonPrimitive.boolean)
        assertTrue(f.posts[1].getValue("submitAttempted").jsonPrimitive.boolean); assertEquals(signed.wire, f.posts[1].getValue("wire").jsonPrimitive.content)
        val third = f.client(MemoryStore(second.disk.value)); third.repo.open()
        assertTrue(runCatching { third.repo.submit() }.isFailure); assertEquals(2, f.posts.size)
        f.bridge.command(buildJsonObject { put("op", "settle"); put("key", p.idempotencyKey) })
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovery = f.client(MemoryStore(third.disk.value), paused = true); recovery.repo.open()
        val receipt = requireNotNull(recovery.store.read().operation!!.settlement)
        assertEquals(signed.signature, receipt.value.signature); recovery.repo.archive()
        assertNull(recovery.store.read().operation)
        val archived = requireNotNull(recovery.store.archived(p.idempotencyKey)); assertEquals(signed, archived.operation.signed)
        val after = f.inspect(); assertEquals(1, after.getValue("receipts").jsonArray.size); assertEquals(1, after.getValue("wires").jsonArray.size)
        for (field in listOf("preparePosts", "submitPosts", "signatures", "sends")) assertEquals(1, after.getValue(field).jsonPrimitive.int)
        assertEquals(1, f.approvals); assertEquals(2, f.posts.size)
        f.offline = true
        val offline = f.client(MemoryStore(recovery.disk.value), paused = true); offline.repo.open()
        assertEquals(archived, offline.store.archived(p.idempotencyKey)); assertNull(offline.store.read().operation)
    } }
    @Test fun `actual paused prepare refusal survives restart and dual absent recovery before offline declined history`() = Fixture().use { f -> runBlocking {
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val first = f.client(); first.repo.open()
        val failure = runCatching { first.repo.begin(0, 0) }.exceptionOrNull()
        assertTrue(failure is ApiException); assertEquals(503, (failure as ApiException).status); assertEquals("PHASE_E_DISABLED", failure.code)
        val original = first.store.read().operation!!; val key = original.request.idempotencyKey
        assertEquals(RealmSalePrepareRefusal(503, "PHASE_E_DISABLED"), original.prepareRefusal)
        assertTrue(original.prepareAttempted); assertNull(original.preparation); assertFalse(original.signingStarted)
        assertEquals(503, f.posts.single().getValue("status").jsonPrimitive.int)
        assertTrue(f.posts.single().getValue("prepareAttempted").jsonPrimitive.boolean)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovery = f.client(MemoryStore(first.disk.value), paused = true); assertFalse(recovery.walletAvailable)
        recovery.repo.open(); assertEquals(original, recovery.store.read().operation)
        assertNull(recovery.store.archived(key)); val beforeArchive = f.reads.size
        recovery.repo.archiveRefusal()
        assertAbsentReads(f.reads.drop(beforeArchive), key)
        val history = requireNotNull(recovery.store.archived(key)); assertNull(recovery.store.read().operation)
        assertEquals(original.request, history.operation.request); assertEquals(original.prepareRefusal, history.operation.prepareRefusal)
        assertTrue(history.operation.refusalConfirmedAbsent); assertNull(history.operation.settlement); assertNull(history.operation.signed)
        assertNoPurchase(f); assertEquals(1, f.posts.size)
        f.offline = true; val requests = f.server.requestCount
        val offline = f.client(MemoryStore(recovery.disk.value), paused = true); offline.repo.open()
        assertFalse(offline.walletAvailable); assertEquals(history, offline.repo.archived(key)); assertNull(offline.store.read().operation)
        assertEquals(requests, f.server.requestCount)
    } }
    @Test fun `lost real refusal reply remains unknown after authenticated absence and never starts another prepare`() = Fixture().use { f -> runBlocking {
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val first = f.client(); f.losePrepare = true
        assertTrue(runCatching { first.repo.begin(0, 0) }.isFailure)
        val original = first.store.read().operation!!; val key = original.request.idempotencyKey
        assertTrue(original.prepareAttempted); assertNull(original.preparation); assertNull(original.prepareRefusal)
        assertEquals(503, f.posts.single().getValue("status").jsonPrimitive.int)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovery = f.client(MemoryStore(first.disk.value), paused = true); recovery.repo.open()
        assertFalse(recovery.walletAvailable); assertAbsentReads(f.reads, key)
        assertTrue(runCatching { recovery.repo.archiveRefusal() }.isFailure); assertTrue(runCatching { recovery.repo.archive() }.isFailure)
        val ready = f.client(MemoryStore(recovery.disk.value)); ready.repo.open()
        assertTrue(runCatching { ready.repo.begin(0, 0) }.isFailure)
        assertEquals(original, ready.store.read().operation); assertNull(ready.store.archived(key))
        assertNoPurchase(f); assertEquals(1, f.posts.size)
    } }
    @Test fun `available offer exhausted before prepare is explicitly refused and archives only after two fresh absent reads`() = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repo.open()
        val offer = first.game.get("/seeker/realm-sales/offer", mapOf("spot" to "0", "realm" to "0"), first.session.token)
        assertEquals(f.wallet, offer.getValue("wallet").jsonPrimitive.content)
        assertEquals("available", offer.getValue("status").jsonPrimitive.content); assertEquals("none", offer.getValue("authorization").jsonPrimitive.content)
        assertTrue(f.bridge.command(buildJsonObject { put("op", "exhaustQuota") }).getValue("exhausted").jsonPrimitive.boolean)
        val failure = runCatching { first.repo.begin(0, 0) }.exceptionOrNull()
        assertTrue(failure is ApiException); assertEquals(422, (failure as ApiException).status); assertEquals("REALM_SALE_NO_QUOTA", failure.code)
        val original = first.store.read().operation!!; val key = original.request.idempotencyKey
        assertEquals(RealmSalePrepareRefusal(422, "REALM_SALE_NO_QUOTA"), original.prepareRefusal)
        assertTrue(original.prepareAttempted); assertNull(original.preparation); assertFalse(original.signingStarted); assertNull(original.signed); assertFalse(original.submitAttempted)
        assertTrue(f.posts.single().getValue("prepareAttempted").jsonPrimitive.boolean)
        assertTrue(runCatching { first.store.archive(first.store.read()) }.isFailure); assertNull(first.store.archived(key))
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovery = f.client(MemoryStore(first.disk.value), paused = true); recovery.repo.open(); assertFalse(recovery.walletAvailable)
        assertEquals(original, recovery.store.read().operation); assertNull(recovery.store.archived(key))
        val before = f.reads.size; recovery.repo.archiveRefusal(); assertAbsentReads(f.reads.drop(before), key)
        val history = requireNotNull(recovery.repo.archived(key)); assertEquals(original.request, history.operation.request)
        assertEquals(original.prepareRefusal, history.operation.prepareRefusal); assertTrue(history.operation.refusalConfirmedAbsent)
        assertNull(history.operation.settlement); assertNull(history.operation.signed); assertNull(recovery.store.read().operation)
        assertNoPurchase(f); assertEquals(1, f.posts.size)
        f.offline = true; val requests = f.server.requestCount; val offline = f.client(MemoryStore(recovery.disk.value), paused = true)
        offline.repo.open(); assertEquals(history, offline.repo.archived(key)); assertEquals(requests, f.server.requestCount)
    } }
    @Test fun `native failed purchase keeps fee only history through lost reply cold paused GET and explicit fresh archive`() = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repo.open(); first.repo.begin(0, 0)
        val prepared = requireNotNull(first.store.read().operation); val p = requireNotNull(prepared.preparation)
        first.repo.review(); first.repo.sign(); val signed = requireNotNull(first.store.read().operation!!.signed)
        f.loseSubmit = true; assertTrue(runCatching { first.repo.submit() }.isFailure)
        assertTrue(first.store.read().operation!!.submitAttempted); assertEquals(signed, first.store.read().operation!!.signed)
        assertEquals(1, f.approvals); assertEquals(2, f.posts.size)
        assertTrue(f.posts[0].getValue("prepareAttempted").jsonPrimitive.boolean)
        assertTrue(f.posts[1].getValue("submitAttempted").jsonPrimitive.boolean)
        assertEquals(signed.wire, f.posts[1].getValue("wire").jsonPrimitive.content)
        val bank = f.bridge.command(buildJsonObject { put("op", "fail"); put("key", p.idempotencyKey) })
        assertTrue(bank.getValue("verified").jsonPrimitive.boolean)
        assertEquals((p.quote.feeLamports.toBigInteger() + java.math.BigInteger.ONE).toString(), bank.getValue("feeLamports").jsonPrimitive.content)
        assertEquals(prepared.policy.protocol.quotaMax.toLong() - p.quote.quotaRemaining, bank.getValue("quotaSales").jsonPrimitive.long)
        assertEquals(p.terms.priorExpiry, bank.getValue("accessExpiresAt").jsonPrimitive.content)
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val readStart = f.reads.size
        val recovery = f.coldClient(MemoryStore(first.disk.value), paused = true); assertFalse(recovery.walletAvailable); recovery.repo.open()
        val op = requireNotNull(recovery.store.read().operation); val evidence = requireNotNull(op.failure); val receipt = evidence.value.receipt
        assertEquals(signed, op.signed); assertEquals(prepared.policy, op.policy); assertNull(op.settlement)
        assertEquals(bank.getValue("feeLamports").jsonPrimitive.content, receipt.feeLamports); assertNull(receipt.blockTime)
        assertEquals("0", receipt.actualRentLamports); assertEquals("0", receipt.buyerNetPaymentLamports)
        assertFalse(receipt.accessChanged); assertFalse(receipt.quotaConsumed); assertFalse(receipt.paymentAuthorized)
        assertFalse(evidence.value.purchaseFinalized); assertFalse(evidence.value.journalClearingAuthorized)
        assertTrue(f.reads.drop(readStart).all { it.getValue("status").jsonPrimitive.int == 200 })
        assertTrue(f.reads.drop(readStart).any { it.getValue("path").jsonPrimitive.content == "/api/seeker/realm-sales/failures/by-key/${p.idempotencyKey}" })
        assertTrue(runCatching { recovery.repo.sign() }.isFailure); assertTrue(runCatching { recovery.repo.submit() }.isFailure)
        val archiveStart = f.reads.size; recovery.repo.archiveFailed()
        val archiveReads = f.reads.drop(archiveStart); assertEquals(2, archiveReads.size)
        assertEquals(setOf("/api/seeker/realm-sales/by-key/${p.idempotencyKey}", "/api/seeker/realm-sales/failures/by-key/${p.idempotencyKey}"),
            archiveReads.map { it.getValue("path").jsonPrimitive.content }.toSet())
        archiveReads.forEach { assertEquals(200, it.getValue("status").jsonPrimitive.int) }
        val history = requireNotNull(recovery.store.archived(p.idempotencyKey)); assertNull(recovery.store.read().operation)
        assertEquals(op, history.operation); assertEquals(signed, history.operation.signed); assertEquals(prepared.policy, history.operation.policy)
        val after = f.inspect(); assertEquals(1, after.getValue("failures").jsonArray.size); assertTrue(after.getValue("receipts").jsonArray.isEmpty())
        assertEquals(1, after.getValue("wires").jsonArray.size); assertEquals(1, after.getValue("preparations").jsonArray.size)
        for (field in listOf("preparePosts", "submitPosts", "signatures", "sends")) assertEquals(1, after.getValue(field).jsonPrimitive.int)
        assertEquals(1, f.approvals); assertEquals(2, f.posts.size)
        f.offline = true; val requests = f.server.requestCount
        val offline = f.coldClient(MemoryStore(recovery.disk.value), paused = true); offline.repo.open()
        assertFalse(offline.walletAvailable); assertNull(offline.store.read().operation); assertEquals(history, offline.repo.archived(p.idempotencyKey))
        assertEquals(requests, f.server.requestCount); assertEquals(1, f.approvals); assertEquals(2, f.posts.size)
    } }
    @Test fun `signed purchase and next day renewal fund the exact paid access used by a late expedition`() = Fixture(composed = true).use { f -> runBlocking {
        val buyer = f.client(); buyer.repo.open(); buyer.repo.begin(0, 0)
        val first = requireNotNull(buyer.store.read().operation!!.preparation)
        assertEquals("0", first.terms.priorExpiry)
        buyer.repo.review(); buyer.repo.sign(); buyer.repo.submit()
        f.bridge.command(buildJsonObject { put("op", "settle"); put("key", first.idempotencyKey) })
        buyer.repo.open(); val firstReceipt = requireNotNull(buyer.store.read().operation!!.settlement)
        buyer.repo.archive()
        val day = f.bridge.command(buildJsonObject { put("op", "nextDay") })
        assertEquals(firstReceipt.value.purchase.expiresAt, day.getValue("accessExpiresAt").jsonPrimitive.content)
        assertEquals(first.terms.day.toBigInteger() + java.math.BigInteger.ONE, day.getValue("day").jsonPrimitive.content.toBigInteger())
        assertEquals(1, day.getValue("priorDaySales").jsonPrimitive.int); assertEquals(0, day.getValue("newDaySales").jsonPrimitive.int)
        assertTrue(day.getValue("accessUnchanged").jsonPrimitive.boolean)
        buyer.repo.begin(0, 0); val renewal = requireNotNull(buyer.store.read().operation!!.preparation)
        assertNotEquals(first.idempotencyKey, renewal.idempotencyKey)
        assertEquals(firstReceipt.value.purchase.expiresAt, renewal.terms.priorExpiry)
        assertEquals(day.getValue("day").jsonPrimitive.content, renewal.terms.day)
        buyer.repo.review(); buyer.repo.sign(); buyer.repo.submit()
        val secondSigned = requireNotNull(buyer.store.read().operation!!.signed)
        f.bridge.command(buildJsonObject { put("op", "settle"); put("key", renewal.idempotencyKey) })
        f.bridge.command(buildJsonObject { put("op", "restart"); put("paused", true) })
        val recovered = f.coldClient(MemoryStore(buyer.disk.value), paused = true); recovered.repo.open()
        val secondReceipt = requireNotNull(recovered.store.read().operation!!.settlement)
        assertEquals(secondSigned.signature, secondReceipt.value.signature)
        assertEquals(firstReceipt.value.purchase.expiresAt, secondReceipt.value.purchase.coverageStart)
        assertTrue(secondReceipt.value.purchase.expiresAt.toBigInteger() > firstReceipt.value.purchase.expiresAt.toBigInteger())
        assertEquals(firstReceipt, recovered.store.archived(first.idempotencyKey)!!.operation.settlement)
        recovered.repo.archive(); assertFalse(recovered.walletAvailable)
        val ready = f.bridge.command(buildJsonObject { put("op", "nearExpiry") })
        f.cookie = ready.getValue("cookie").jsonPrimitive.content // Explicit fixture reauthentication after >7 days.
        val late = f.client(MemoryStore(recovered.disk.value), paused = true)
        val expedition = ExpeditionClient(f, late); expedition.repository.refresh(); expedition.repository.selectPaidRealm(0)
        val paid = requireNotNull(expedition.repository.state.value.paidView)
        assertEquals("covered", paid.coverage.status); assertEquals(secondReceipt.value.purchase.expiresAt, paid.coverage.expiresAt)
        expedition.repository.reviewPaidDeparture(0); val review = requireNotNull(expedition.repository.state.value.review)
        expedition.repository.confirm(review)
        val accepted = requireNotNull(expedition.store.read().operation!!.proof!!.receipt)
        val access = requireNotNull(accepted.route.access!!.observation)
        assertEquals(f.wallet, access.wallet); assertEquals(0, access.realm)
        assertEquals(ready.getValue("accessAddress").jsonPrimitive.content, access.accessAddress)
        assertEquals(ready.getValue("configAddress").jsonPrimitive.content, access.configAddress)
        assertEquals(secondReceipt.value.purchase.expiresAt, access.expiresAt)
        assertEquals(secondReceipt.value.receipt.source.accounts.single { it.address == access.accessAddress },
            access.source.accounts.single { it.address == access.accessAddress })
        assertEquals(secondReceipt.value.receipt.source.programId, access.source.programId)
        assertEquals(secondReceipt.value.receipt.source.genesisHash, access.source.genesisHash)
        val advanced = f.bridge.command(buildJsonObject { put("op", "advanceReturn"); put("key", review.command.key) })
        assertTrue(advanced.getValue("afterCoverageExpiry").jsonPrimitive.boolean)
        expedition.repository.check(); val returned = requireNotNull(expedition.store.read().operation!!.proof)
        assertNotNull(returned.returned); assertEquals(accepted, returned.receipt)
        expedition.repository.finish(); assertEquals(1, expedition.hydrations)
        expedition.repository.selectPaidRealm(0)
        assertEquals("EXPIRED", expedition.repository.state.value.paidView!!.coverage.reason)
        assertTrue(runCatching { expedition.repository.reviewPaidDeparture(0) }.isFailure)
        // A direct fresh authenticated command also proves the server refuses a
        // new departure; this is separate from the native preview refusal.
        val body = JsonObject(review.command.request.body() + ("idempotencyKey" to JsonPrimitive(java.util.UUID.randomUUID().toString())))
        val refused = runCatching { late.game.post("/starter-expeditions", body, late.session.token) }.exceptionOrNull()
        assertTrue(refused is ApiException); assertEquals("EXPEDITION_ACCESS_EXPIRED", (refused as ApiException).code)
        val state = f.bridge.command(buildJsonObject { put("op", "inspect"); put("key", review.command.key) })
        for (field in listOf("preparePosts", "submitPosts", "signatures", "sends")) assertEquals(2, state.getValue(field).jsonPrimitive.int)
        assertEquals(2, state.getValue("receipts").jsonArray.size); assertEquals(2, state.getValue("wires").jsonArray.size)
        assertEquals(1, state.getValue("departures").jsonPrimitive.int); assertEquals(1, state.getValue("returns").jsonPrimitive.int)
        assertEquals(0, state.getValue("inflight").jsonPrimitive.int); assertEquals(accepted.route.netQuantity, state.getValue("stock").jsonPrimitive.content)
        assertEquals(2, f.approvals); assertEquals(6, f.posts.size)
    } }
    private class ExpeditionClient(f: Fixture, client: Client) {
        val store = StarterExpeditionStore(MemoryStore(), StarterIdentity(client.session.origin, "devnet", f.wallet))
        private var directory: BaseDirectory? = null
        var hydrations = 0
        val repository = StarterExpeditionRepository(client.session, client.holder, client.api, store, { f.baseId }, { 0L }, { directory }, {
            assertEquals(f.wallet, client.api.get("/me").getValue("wallet").jsonPrimitive.content)
            directory = BaseDirectory.from(client.api.get("/bases"))
        }, { guard ->
            val original = requireNotNull(store.read().operation!!.proof!!.receipt)
            val fresh = StarterExpeditionView.from(client.api.getStarterExpedition("/starter-expeditions", mapOf("baseId" to f.baseId), guard))
            assertEquals(original.route.netQuantity, fresh.rawStock.single { it.resourceId == original.route.resourceId }.available)
            hydrations++; guard()
        }, { true })
    }
    private fun assertAbsentReads(reads: List<JsonObject>, key: String) {
        assertEquals(2, reads.size)
        assertEquals(setOf("/api/seeker/realm-sales/prepare/by-key/$key", "/api/seeker/realm-sales/by-key/$key"), reads.map { it.getValue("path").jsonPrimitive.content }.toSet())
        reads.forEach {
            assertEquals(200, it.getValue("status").jsonPrimitive.int)
            val body = Json.parseToJsonElement(it.getValue("body").jsonPrimitive.content).jsonObject
            assertEquals(key, body.getValue("idempotencyKey").jsonPrimitive.content); assertEquals(JsonNull, body.getValue("preparation"))
            if (it.getValue("path").jsonPrimitive.content == "/api/seeker/realm-sales/by-key/$key") {
                assertEquals(JsonNull, body.getValue("wire")); assertEquals(JsonNull, body.getValue("settlement"))
            }
        }
    }
    private fun assertNoPurchase(f: Fixture) {
        val after = f.inspect(); assertEquals(1, after.getValue("preparePosts").jsonPrimitive.int)
        for (field in listOf("submitPosts", "signatures", "sends")) assertEquals(0, after.getValue(field).jsonPrimitive.int)
        for (field in listOf("preparations", "wires", "receipts")) assertTrue(after.getValue(field).jsonArray.isEmpty())
        assertEquals(0, f.approvals)
    }
    private class Client(f: Fixture, val disk: MemoryStore, paused: Boolean) {
        val holder = testHolder()
        private val cookies = SessionCookieJar(f.server.url("/"), MemoryStore()).apply {
            saveFromResponse(f.server.url("/"), listOf(requireNotNull(Cookie.parse(f.server.url("/"), f.cookie))))
        }
        val game = GameApi.withTransport(f.server.url("/").toString(), cookies, "native-realm-sale-fixture", f.transport)
        val session = AccountSession(f.wallet, f.server.url("/").toString().trimEnd('/'), game.sessionToken()).also(holder::replace)
        val api = SessionApiClient(game, session.token, ApiRouting())
        val store = RealmSalesStore(disk, StarterIdentity(session.origin, "devnet", f.wallet), f.failurePins)
        private val wallet = if (paused) null else RealmSalesWallet(session, holder, session.origin, SolanaCluster.DEVNET, { false }, { null },
            RealmSalesExternalSigner { prepared, cluster, onSigned, guard ->
                assertEquals(SolanaCluster.DEVNET, cluster); guard(); assertTrue(store.read().operation!!.signingStarted)
                f.approvals++
                val reply = f.bridge.command(buildJsonObject { put("op", "sign"); put("unsigned", Base64.getEncoder().encodeToString(prepared.unsignedTransaction())) })
                val signed = prepared.verifySignedBase64(reply.getValue("wire").jsonPrimitive.content)
                onSigned(signed); guard(); signed
            })
        val walletAvailable get() = wallet != null
        val ports = RealmSalesAppPorts(session, holder, api, store, { if (paused) null else f.catalogue }, { if (paused) null else f.pins },
            { RealmSalesLifecycle(true, true, 0, !paused, !paused, "fixture-content", false) }, object : RealmSalesRpcReads {
                override suspend fun genesisHash() = f.pins.genesisHash
                override suspend fun finalizedBlockHeight() = f.height
            }, f.rpcGate, { prepared, guard, retain -> requireNotNull(wallet).sign(prepared, retain, guard); Unit }, { guard -> requireNotNull(wallet).requireAvailable(guard) }, { System.nanoTime() / 1_000_000 })
        val repo = RealmSalesRepository(store, ports)
    }
    private class Fixture(composed: Boolean = false) : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val rpcGate = RealmSalesRpcGate(); val bridge = Bridge(composed)
        private val setup = try { bridge.command(buildJsonObject { put("op", "start"); put("origin", server.url("/").toString().trimEnd('/')) }) }
        catch (error: Throwable) { runCatching { bridge.close() }; server.shutdown(); transport.dispatcher.executorService.shutdown(); rpcGate.close(); throw error }
        val wallet = setup.getValue("wallet").jsonPrimitive.content; var cookie = setup.getValue("cookie").jsonPrimitive.content
        val baseId = setup["baseId"]?.jsonPrimitive?.content ?: ""
        val height = setup.getValue("blockHeight").jsonPrimitive.long
        val pins = setup.getValue("trust").jsonObject.let { p -> fun t(k: String) = p.getValue(k).jsonPrimitive.content
            RealmSaleSigningTrust(t("genesisHash"), t("programId"), t("developer"), t("reviewedProgramDataSha256"), p.getValue("reviewedDeploymentSlot").jsonPrimitive.long, t("revision")) }
        // Independent fixture-bank policy is supplied by start, never copied from a recovery receipt.
        val failurePins get() = RealmSaleFailureTrust(pins, setup.getValue("upgradeAuthority").let { if (it == JsonNull) null else it.jsonPrimitive.content })
        val catalogue = setup.getValue("catalogue").jsonObject
        val posts = mutableListOf<JsonObject>(); val reads = mutableListOf<JsonObject>(); var approvals = 0
        @Volatile var offline = false; @Volatile var losePrepare = false; @Volatile var loseSubmit = false; @Volatile private var active: Client? = null
        init { server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (offline) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                val body = request.body.readUtf8()
                val journal = if (request.method == "POST") runBlocking { active?.store?.read()?.operation } else null
                val result = try { bridge.command(buildJsonObject {
                    put("op", "request"); put("method", request.method); put("url", request.path)
                    put("headers", buildJsonObject { request.headers.names().forEach { put(it, request.getHeader(it)) } })
                    if (body.isNotEmpty()) put("body", body)
                }) } catch (error: Exception) { return MockResponse().setResponseCode(500).setBody(buildJsonObject {
                    put("error", buildJsonObject { put("code", "PAIRED_FIXTURE_ERROR"); put("message", error.message) }) }.toString()) }
                if (request.method == "GET") reads += buildJsonObject { put("path", request.path); put("status", result.getValue("status")); put("body", result.getValue("body")) }
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
        fun coldClient(disk: MemoryStore, paused: Boolean): Client {
            // Restart proof must not inherit positive holds from this JVM's shared identity roster.
            // All preceding original requests have drained before discarding this fixture identity.
            val field = RealmSalesStore::class.java.getDeclaredField("identities").also { it.isAccessible = true }
            @Suppress("UNCHECKED_CAST") (field.get(null) as MutableMap<StarterIdentity, *>).remove(StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", wallet))
            return client(disk, paused)
        }
        fun inspect() = bridge.command(buildJsonObject { put("op", "inspect") })
        override fun close() { try { bridge.close() } finally { rpcGate.close(); server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() } }
    }
    private class Bridge(composed: Boolean) : AutoCloseable {
        private val root = File(requireNotNull(System.getenv("PHASE_E_API_ROOT")))
        private val script = root.resolve(if (composed) "apps/api/test/fixtures/nativeRealmSaleRenewalApiFixture.ts" else "apps/api/test/fixtures/nativeRealmSalesApiFixture.ts").also { require(it.isFile) }
        private val process = ProcessBuilder("node", "--import", "tsx", script.absolutePath).directory(root.resolve("apps/api"))
            .redirectError(ProcessBuilder.Redirect.INHERIT).apply { environment()["NODE_ENV"] = "test"; environment()["PHASE_E_NATIVE_PAIRED"] = "1" }.start()
        private val input = process.outputStream.bufferedWriter(); private val output = process.inputStream.bufferedReader()
        private val reads = Executors.newSingleThreadExecutor()
        @Synchronized fun command(value: JsonObject): JsonObject {
            input.write(value.toString()); input.newLine(); input.flush()
            val line = reads.submit<String> {
                while (true) { val next = output.readLine() ?: error("Native realm sale fixture exited"); if (next.startsWith(PREFIX)) return@submit next.removePrefix(PREFIX) }
                @Suppress("UNREACHABLE_CODE") error("unreachable")
            }.get(60, TimeUnit.SECONDS)
            return Json.parseToJsonElement(line).jsonObject.also { check(it["error"] == null) { "Native realm sale fixture failed: ${it["error"]}" } }
        }
        override fun close() { try { input.close(); check(process.waitFor(10, TimeUnit.SECONDS)); check(process.exitValue() == 0) }
            finally { process.destroyForcibly(); reads.shutdownNow(); output.close() } }
        companion object { const val PREFIX = "NATIVE_REALM_SALES_FIXTURE:" }
    }
}
