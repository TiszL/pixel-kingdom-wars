package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.Closeable
import java.io.IOException
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsRepositoryTest {
    private class Memory : SecretStore {
        @Volatile var value: String? = null; var failWrites = false; var afterWrite: () -> Unit = {}
        override fun read() = value
        override fun write(value: String) { if (failWrites) throw IOException("fixture storage unavailable"); this.value = value; afterWrite() }
        override fun clear() = error("Tax history cannot be cleared")
    }
    private class Fixture(val kind: String = "combined") : MiningTaxClaimsPorts, Closeable {
        val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-journal-fixtures.json")).readText()).jsonObject
        val recoveries = fixture.getValue("recoveries").jsonObject
        val recovery = MiningTaxClaimsRecoveryEnvelope.from(recoveries.getValue(kind).jsonObject)
        val p = requireNotNull(recovery.preparation)
        val rules = MiningTaxClaimsSigningPolicy(fixture.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
        val pins = MiningTaxClaimsSigningTrust(p.source.genesisHash, p.source.programId, p.identity.configAddress, p.identity.keepMint,
            p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
        val disk = Memory(); val cookies = Memory(); val server = MockWebServer()
        val client: OkHttpClient
        val identity: StarterIdentity; val jar: SessionCookieJar; val holder = AccountSessionHolder(dispatcher = Dispatchers.Unconfined); val session: AccountSession
        val store: MiningTaxClaimsStore
        override val transport: MiningTaxClaimsTransport
        var repo: MiningTaxClaimsRepository
        var allowed = true; var provider = true; var hasPins = true; var current = true; var now = 0L; var walletAvailable = true
        var prepared = false; var finalOrdinal: Int? = null; val submitted = mutableSetOf<Int>()
        var lostPrepare = false; var lostSubmit = false; var unknownPrepare = false; var unknownWallet = false; var lateWallet = false
        var badReceipt = false; var badActor = false; var badSetupPaid = false; var unavailableReview = false; var uncertainAck = false
        var failureStatus = 200; var badFailureWire = false; var failedOrdinals = emptyList<Int>(); var lostFailures = false; var badFailure = false; var atFailureRead: suspend () -> Unit = {}
        var signCalls = 0; var liveCalls = 0; val calls = java.util.Collections.synchronizedList(mutableListOf<String>())
        var duringLive: suspend () -> Unit = {}; var atAssociation: suspend () -> Unit = {}; var beforeEvidence: suspend () -> Unit = {}; var afterEvidence: suspend () -> Unit = {}
        init {
            val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
            val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
            val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
            client = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
                .dns(object : Dns { override fun lookup(hostname: String) = listOf(java.net.InetAddress.getByName("127.0.0.1")) }).build()
            server.protocols = listOf(Protocol.HTTP_1_1); server.useHttps(tls.sslSocketFactory(), false); server.start()
            identity = StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", p.wallet)
            jar = SessionCookieJar(server.url("/"), cookies); session = AccountSession(p.wallet, identity.origin, jar.sessionToken()); holder.replace(session)
            store = MiningTaxClaimsStore(disk, identity, pins, rules)
            transport = MiningTaxClaimsTransport(MiningTaxClaimsHttpPort(identity, jar, session.token, "fixture", client)) { allowed }
            repo = MiningTaxClaimsRepository(store, this)
            server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = runBlocking {
                    val path = requireNotNull(request.path); calls += "${request.method} $path"
                    when {
                        path.endsWith("/prepare") -> {
                            assertTrue(store.read().operation!!.prepareAttempted)
                            val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                            assertEquals(p.idempotencyKey, body.getValue("idempotencyKey").jsonPrimitive.content)
                            prepared = !unknownPrepare
                            if (lostPrepare) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else response(preparation())
                        }
                        path.contains("/prepare/by-key/") -> response(preparation())
                        path.contains("/review/by-key/") -> response(review(path.last().digitToInt()))
                        path.contains("/failures/by-key/") -> {
                            atFailureRead()
                            if (lostFailures) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else response(failures()).setResponseCode(failureStatus)
                        }
                        path.endsWith("/submit") -> {
                            val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                            val encoded = body.getValue("signedTransaction").jsonPrimitive.content
                            val ordinal = recovery.wires.indexOfFirst { signed(it) == encoded }; check(ordinal >= 0)
                            assertTrue(store.read().operation!!.transactions.single { it.ordinal == ordinal }.submitAttempted)
                            submitted += ordinal; finalOrdinal = ordinal
                            if (lostSubmit) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else response(ack(ordinal))
                        }
                        else -> response(saved())
                    }
                }
            }
        }
        fun signed(w: MiningTaxClaimsSignedWire) = Base64.getEncoder().encodeToString(w.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        fun response(raw: JsonObject) = MockResponse().setBody(raw.toString())
        fun preparation() = buildJsonObject {
            put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("status", if (prepared) "prepared" else "unknown")
            put("preparation", if (prepared) recoveries.getValue(kind).jsonObject.getValue("preparation") else JsonNull); put("serverNow", p.preparedAt)
        }
        fun saved(): JsonObject {
            val base = if (p.transactions.size == 2 && finalOrdinal == 0) recoveries.getValue("setup").jsonObject else recoveries.getValue(kind).jsonObject
            return buildJsonObject {
                put("wallet", if (badActor) p.identity.keepMint else p.wallet); put("idempotencyKey", p.idempotencyKey)
                put("claimId", if (prepared) JsonPrimitive(p.claimId) else JsonNull)
                put("preparation", if (prepared) base.getValue("preparation") else JsonNull)
                put("status", if (!prepared) "unknown" else if (finalOrdinal != null) if (p.transactions.size == 2 && finalOrdinal == 0) "setup" else "settled" else if (submitted.isNotEmpty()) "signed" else "prepared")
                put("wires", JsonArray(recoveries.getValue(kind).jsonObject.getValue("wires").jsonArray.filterIndexed { i, _ -> i in submitted }))
                put("settlement", if (badReceipt) JsonPrimitive("broken") else if (finalOrdinal != null) base.getValue("settlement") else JsonNull)
                put("serverNow", base.getValue("serverNow"))
            }
        }
        fun failures(): JsonObject {
            val raw = if (failedOrdinals.isEmpty()) buildJsonObject { put("recovery", saved()); put("failures", JsonArray(emptyList())) }
            else taxFailureFixture(recovery.copy(wires = recovery.wires.filter { it.ordinal.toInt() in submitted }), failedOrdinals,
                if (p.transactions.size == 2 && finalOrdinal == 0) MiningTaxClaimsRecoveryEnvelope.from(recoveries.getValue("setup").jsonObject) else null)
            var result = if (badFailureWire) corruptTaxFailureWire(raw) else raw
            if (badActor) result = JsonObject(result + ("recovery" to JsonObject(result.getValue("recovery").jsonObject + ("wallet" to JsonPrimitive(p.identity.keepMint)))))
            return if (badFailure) JsonObject(result + ("failures" to JsonPrimitive("broken"))) else result
        }
        fun ack(ordinal: Int) = buildJsonObject {
            put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("claimId", if (uncertainAck) JsonNull else JsonPrimitive(p.claimId))
            put("wire", if (uncertainAck) JsonNull else recoveries.getValue(kind).jsonObject.getValue("wires").jsonArray[ordinal])
            put("delivery", if (uncertainAck) "held" else if (p.transactions.size == 2 && ordinal == 0) "setup" else "settled")
            if (uncertainAck) put("reason", "STORAGE_UNCERTAIN"); put("serverNow", p.preparedAt)
        }
        fun review(ordinal: Int): JsonObject = buildJsonObject {
            put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("ordinal", ordinal)
            put("status", if (unavailableReview) "unavailable" else "ready"); put("serverNow", Instant.parse(p.preparedAt).plusSeconds(2).toString().replace("Z", ".000Z"))
            if (unavailableReview) { put("review", JsonNull); put("reason", "EXPIRED") } else put("review", buildJsonObject {
                val tx = p.transactions[ordinal]; put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("claimId", p.claimId); put("ordinal", ordinal); put("status", "ready")
                put("messageSha256", tx.messageSha256); put("blockhash", p.blockhash); put("preparedAt", p.preparedAt); put("expiresAt", p.expiresAt)
                put("observedAt", Instant.parse(p.preparedAt).plusSeconds(1).toString().replace("Z", ".000Z"))
                put("feeLamports", tx.feeLamports); put("rentLamports", tx.rentLamports); put("totalLamports", (tx.feeLamports.toBigInteger() + tx.rentLamports.toBigInteger()).toString())
                val setup = if (ordinal == 1) MiningTaxClaimsRecoveryEnvelope.from(recoveries.getValue("setup").jsonObject).settlement!!.receipt else null
                put("paidFeeLamports", if (badSetupPaid) "0" else setup?.feeLamports ?: "0"); put("paidRentLamports", setup?.rentLamports ?: "0")
                put("source", buildJsonObject {
                    put("genesisHash", p.source.genesisHash); put("programId", p.source.programId); put("reviewedDeploymentSlot", p.source.reviewedDeploymentSlot); put("reviewedProgramDataSha256", p.source.reviewedProgramDataSha256)
                    put("snapshotSlot", maxOf(p.source.snapshotSlot, p.source.blockhashSlot) + 1); put("feeSlot", maxOf(p.source.snapshotSlot, p.source.blockhashSlot) + 1); put("blockHeight", p.blockHeight); put("lastValidBlockHeight", p.lastValidBlockHeight)
                }); put("currentSigningAuthorized", false); put("relayAuthorized", false); put("settlementAuthorized", false)
            })
        }
        override fun capture(newAction: Boolean): () -> Unit = { holder.requireCurrent(session); check(current); if (newAction) check(allowed && provider) }
        override fun policy() = if (hasPins) rules else null
        override fun trust() = if (hasPins) pins else null
        override fun totalSpots() = 256
        override fun key() = p.idempotencyKey
        override fun clockMs() = now
        override suspend fun live(preparation: MiningTaxClaimsPreparation, ordinal: Int, guard: () -> Unit) { guard(); liveCalls++; duringLive(); guard() }
        override val wallet get() = MiningTaxClaimsWallet(session, holder, identity.origin, SolanaCluster.DEVNET, { atAssociation(); false }, { null },
            if (!walletAvailable) null else MiningTaxClaimsExternalSigner { prepared, _, retain, guard ->
                guard(); signCalls++; assertTrue(store.read().operation!!.transactions.single { it.ordinal == prepared.ordinal }.signingStarted)
                if (unknownWallet) throw IOException("Unknown wallet response")
                beforeEvidence(); guard(); val result = prepared.verifySignedBase64(signed(recovery.wires[prepared.ordinal]))
                if (lateWallet) holder.replace(null)
                retain(result); withContext(NonCancellable) { afterEvidence() }; guard(); result
            })
        suspend fun begin() = repo.begin(p.round, p.spot, p.caps)
        suspend fun sign(ordinal: Int = 0) { repo.review(ordinal); repo.sign(ordinal) }
        suspend fun stage(ordinal: Int = 0) { sign(ordinal); repo.submit(ordinal); repo.recover() }
        fun restarted() = MiningTaxClaimsRepository(MiningTaxClaimsStore(disk, identity, pins, rules), this).also { repo = it }
        override fun close() { server.close(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private suspend fun refuses(block: suspend () -> Unit) { val r = runCatching { block() }; if (r.exceptionOrNull() is AssertionError) throw r.exceptionOrNull()!!; assertTrue(r.isFailure) }
    @Test fun `single claim combined and above quote recover full payment then explicitly archive without a live provider`() = runBlocking {
        for (kind in listOf("claim", "combined", "aboveQuote")) Fixture(kind).use { f ->
            f.begin(); f.sign(); f.repo.submit(0); assertNull(f.store.read().operation!!.settlement)
            f.allowed = false; f.provider = false; f.hasPins = false; f.restarted().open()
            assertNotNull(f.store.read().operation!!.settlement); assertNotNull(f.store.read().operation)
            f.repo.archive(); assertNull(f.store.read().operation); assertNotNull(f.repo.archived(f.p.idempotencyKey))
            assertEquals(1, f.signCalls); assertEquals(2, f.calls.count { it.startsWith("POST ") })
        }
    }
    @Test fun `split setup is nonterminal and ordinal one requires another explicit review and approval`() = runBlocking { Fixture("split").use { f ->
        f.begin(); f.stage(0); assertNotNull(f.store.read().operation!!.setup); assertNull(f.store.read().operation!!.settlement); refuses { f.repo.archive() }
        refuses { f.repo.sign(1) }; assertEquals(1, f.signCalls); f.stage(1)
        assertEquals(2, f.signCalls); assertNotNull(f.store.read().operation!!.settlement); f.repo.archive(); assertNotNull(f.repo.archived(f.p.idempotencyKey))
    } }
    @Test fun `ordinal one fresh review must report exact durable setup costs even when lower values fit caps`() = runBlocking { Fixture("split").use { f ->
        f.begin(); f.stage(0); f.badSetupPaid = true; refuses { f.repo.review(1) }; assertEquals(1, f.signCalls)
        assertFalse(f.store.read().operation!!.transactions.any { it.ordinal == 1 }); f.badSetupPaid = false; f.stage(1)
    } }
    @Test fun `lost prepare retains the original request and restart recovery only reads its key`() = runBlocking { Fixture().use { f ->
        f.lostPrepare = true; refuses { f.begin() }; assertTrue(f.store.read().operation!!.prepareAttempted)
        val before = f.calls.size; f.restarted().open(); assertNotNull(f.store.read().operation!!.preparation)
        assertTrue(f.calls.drop(before).all { it.startsWith("GET ") }); refuses { f.begin() }; assertEquals(1, f.calls.count { it.startsWith("POST ") })
    } }
    @Test fun `unknown prepare or unsigned expiry cannot replace archive sign or replay the original intent`() = runBlocking {
        for (unknown in listOf(true, false)) Fixture().use { f ->
            if (unknown) { f.lostPrepare = true; f.unknownPrepare = true; refuses { f.begin() } } else { f.begin(); f.unavailableReview = true }
            f.restarted().open(); refuses { f.repo.review(0) }; refuses { f.repo.sign(0) }; refuses { f.repo.archive() }; refuses { f.begin() }
            assertNotNull(f.store.read().operation); assertEquals(0, f.signCalls); assertEquals(1, f.calls.count { it.startsWith("POST ") })
        }
    }
    @Test fun `lost submit persists attempt and cannot rebroadcast after restart or paused recovery`() = runBlocking { Fixture().use { f ->
        f.begin(); f.sign(); f.lostSubmit = true; refuses { f.repo.submit(0) }; assertTrue(f.store.read().operation!!.transactions.single().submitAttempted)
        f.allowed = false; f.provider = false; f.restarted().open(); refuses { f.repo.submit(0) }; assertNotNull(f.store.read().operation!!.settlement)
        assertEquals(1, f.signCalls); assertEquals(1, f.calls.count { it.endsWith("/submit") })
    } }
    @Test fun `unknown wallet never permits another approval or archive and missing wallet never consumes an attempt`() = runBlocking { Fixture().use { f ->
        f.begin(); f.repo.review(0); f.walletAvailable = false; refuses { f.repo.sign(0) }; assertTrue(f.store.read().operation!!.transactions.isEmpty())
        f.walletAvailable = true; f.repo.review(0); f.unknownWallet = true; refuses { f.repo.sign(0) }; f.restarted().open()
        refuses { f.repo.review(0) }; refuses { f.repo.sign(0) }; refuses { f.repo.archive() }; assertEquals(1, f.signCalls)
    } }
    @Test fun `late wallet signature is retained despite logout and never published to the obsolete view`() = runBlocking { Fixture().use { f ->
        f.begin(); f.repo.review(0); f.lateWallet = true; refuses { f.repo.sign(0) }
        assertNotNull(f.store.read().operation!!.transactions.single().signed); assertNull(f.repo.state.value.journal!!.operation!!.transactions.single().signed)
    } }
    @Test fun `freshness uses monotonic elapsed time including last wallet guard and never extends saved expiry`() = runBlocking {
        for (backwards in listOf(true, false)) Fixture().use { f ->
            f.begin(); f.repo.review(0); f.now = if (backwards) -1 else 1_000_000; refuses { f.repo.sign(0) }; assertEquals(0, f.signCalls)
        }
        Fixture().use { f -> f.begin(); f.repo.review(0); f.duringLive = { f.now = 1_000_000 }; refuses { f.repo.sign(0) }; assertEquals(0, f.signCalls); assertTrue(f.store.read().operation!!.transactions.isEmpty()) }
    }
    @Test fun `admission change at wallet association prevents a new signature while started marker remains held`() = runBlocking { Fixture().use { f ->
        f.begin(); f.repo.review(0); f.beforeEvidence = { f.allowed = false }
        refuses { f.repo.sign(0) }; assertNull(f.store.read().operation!!.transactions.single().signed); f.allowed = true; refuses { f.repo.sign(0) }
        assertEquals(1, f.signCalls)
    } }
    @Test fun `completed explicit review task permits a later explicit approval task under the same live session`() = runBlocking { Fixture().use { f ->
        async { f.begin() }.await(); async { f.repo.review(0) }.await(); async { f.repo.sign(0) }.await()
        assertNotNull(f.store.read().operation!!.transactions.single().signed); assertEquals(1, f.signCalls)
    } }
    private suspend fun lateSignHold(other: Boolean) { Fixture().use { f ->
        f.begin(); f.repo.review(0)
        f.atAssociation = { if (f.store.read().operation!!.transactions.any { it.signingStarted }) f.store.observeSettlementKey(if (other) f.p.claimId else f.p.idempotencyKey, 0) }
        refuses { f.repo.sign(0) }; assertEquals(0, f.signCalls); assertNull(f.store.read().operation!!.transactions.single().signed)
    } }
    private suspend fun lateSubmitHold(other: Boolean) { Fixture().use { f ->
        f.begin(); f.sign(); var observed = false
        f.disk.afterWrite = {
            val op = Json.parseToJsonElement(requireNotNull(f.disk.value)).jsonObject.getValue("operation").jsonObject
            if (!observed && op.getValue("transactions").jsonArray.any { it.jsonObject.getValue("submitAttempted").jsonPrimitive.boolean }) {
                observed = true; f.store.observeSettlementKey(if (other) f.p.claimId else f.p.idempotencyKey, 0)
            }
        }
        refuses { f.repo.submit(0) }; assertTrue(observed); assertTrue(f.store.read().operation!!.transactions.single().submitAttempted)
        assertFalse(f.calls.any { it.endsWith("/submit") })
    } }
    @Test fun `same key positive after signing marker blocks final wallet association guard`() = runBlocking { lateSignHold(false) }
    @Test fun `other key positive after signing marker blocks final wallet association guard`() = runBlocking { lateSignHold(true) }
    @Test fun `same key positive after submit marker blocks final HTTP enqueue guard`() = runBlocking { lateSubmitHold(false) }
    @Test fun `other key positive after submit marker blocks final HTTP enqueue guard`() = runBlocking { lateSubmitHold(true) }
    @Test fun `positive after owned wallet evidence refuses continuation but still retains the exact original wire`() = runBlocking { Fixture().use { f ->
        f.begin(); f.repo.review(0); f.afterEvidence = { f.store.observeSettlementKey(f.p.idempotencyKey, 0) }
        refuses { f.repo.sign(0) }; assertNotNull(f.store.read().operation!!.transactions.single().signed); assertEquals(1, f.signCalls)
    } }
    @Test fun `storage failure refuses an effect before its durable marker and never invents successful wire retention`() = runBlocking {
        Fixture().use { f -> f.disk.failWrites = true; refuses { f.begin() }; assertTrue(f.calls.isEmpty()); assertEquals(0, f.signCalls) }
        Fixture().use { f -> f.begin(); f.repo.review(0); f.beforeEvidence = { f.disk.failWrites = true }; refuses { f.repo.sign(0) }; f.disk.failWrites = false
            assertNull(f.store.read().operation!!.transactions.single().signed); f.restarted().open(); refuses { f.repo.sign(0) }; assertEquals(1, f.signCalls) }
    }
    @Test fun `malformed positive recovery keeps its hold and valid original wire despite adjacent receipt or actor failure`() = runBlocking {
        for (actor in listOf(false, true)) Fixture().use { f ->
            f.begin(); f.repo.review(0); f.unknownWallet = true; refuses { f.repo.sign(0) }
            f.submitted += 0; f.finalOrdinal = 0; if (actor) f.badActor = true else f.badReceipt = true
            refuses { f.repo.recover() }; val op = f.store.read().operation!!
            assertNotNull(op.transactions.single().signed); assertTrue(op.unattributedObserved); assertNull(op.settlement); refuses { f.repo.submit(0) }; refuses { f.repo.archive() }
        }
    }
    @Test fun `storage uncertain submit acknowledgement is never a payment receipt or permission to retry`() = runBlocking { Fixture().use { f ->
        f.begin(); f.sign(); f.uncertainAck = true; f.repo.submit(0); assertNull(f.store.read().operation!!.settlement)
        refuses { f.repo.submit(0) }; assertEquals(1, f.calls.count { it.endsWith("/submit") }); f.repo.recover(); assertNotNull(f.store.read().operation!!.settlement)
    } }
    @Test fun `dismiss invalidates consent and close waits for the owned wallet evidence drain`() = runBlocking { Fixture().use { f ->
        f.begin(); f.repo.review(0); f.repo.dismiss(); refuses { f.repo.sign(0) }; f.repo.review(0)
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); f.afterEvidence = { entered.complete(Unit); release.await() }
        val signing = async { runCatching { f.repo.sign(0) } }; withTimeout(3000) { entered.await() }
        val close = async { f.repo.close() }; yield(); assertFalse(close.isCompleted); assertNotNull(f.store.read().operation!!.transactions.single().signed)
        release.complete(Unit); withTimeout(3000) { signing.await(); close.await() }; refuses { f.repo.open() }; assertEquals(1, f.signCalls)
    } }
    @Test fun `failed atomic recovery and explicit archival use fresh GET while paused without a wallet`() = runBlocking { Fixture().use { f ->
        f.begin(); f.sign(); f.submitted += 0; f.failedOrdinals = listOf(0)
        f.allowed = false; f.provider = false; f.hasPins = false; val before = f.calls.size
        f.restarted().recover(); assertNotNull(f.store.read().operation!!.failure); assertNull(f.store.read().operation!!.settlement)
        val reads = f.calls.count { it.contains("/failures/by-key/") }; f.repo.archiveFailed()
        assertEquals(reads + 1, f.calls.count { it.contains("/failures/by-key/") }); assertTrue(f.calls.drop(before).all { it.startsWith("GET ") })
        assertNull(f.store.read().operation); assertEquals("18446744073709551615", f.repo.archived(f.p.idempotencyKey)!!.operation.failure!!.failures.single().receipt.feeLamports)
        assertEquals(1, f.signCalls); assertEquals(1, f.calls.count { it.startsWith("POST ") })
    } }
    @Test fun `split failed claim archives setup spend without another signature or submission`() = runBlocking { Fixture("split").use { f ->
        f.begin(); f.stage(0); f.sign(1); f.submitted += 1; f.failedOrdinals = listOf(1)
        f.restarted().recover(); val op = f.store.read().operation!!; assertNotNull(op.setup); assertNotNull(op.failure)
        f.allowed = false; f.provider = false; f.repo.archiveFailed(); val archived = f.repo.archived(f.p.idempotencyKey)!!.operation
        assertEquals(op.setup, archived.setup); assertEquals(2, f.signCalls); assertEquals(1, f.calls.count { it.endsWith("/submit") })
    } }
    @Test fun `lost unknown or changed fresh failure reply never clears the saved complete history`() = runBlocking { Fixture().use { f ->
        f.begin(); f.sign(); f.submitted += 0; f.failedOrdinals = listOf(0); f.repo.recover()
        val saved = f.store.read().operation!!.failure
        f.lostFailures = true; refuses { f.repo.archiveFailed() }; f.lostFailures = false
        f.failedOrdinals = emptyList(); refuses { f.repo.archiveFailed() }; assertEquals(saved, f.store.read().operation!!.failure)
        f.failedOrdinals = listOf(0); f.badFailure = true; refuses { f.repo.archiveFailed() }; assertNotNull(f.store.read().operation)
        f.badFailure = false; refuses { f.repo.archiveFailed() }; assertNotNull(f.store.read().operation)
    } }
    @Test fun `fresh failure archive refuses a changed revision and obsolete actor before atomic clear`() = runBlocking { Fixture().use { f ->
        f.begin(); f.sign(); f.submitted += 0; f.failedOrdinals = listOf(0); f.repo.recover()
        f.atFailureRead = { f.store.observeSettlement(f.p.idempotencyKey) }; refuses { f.repo.archiveFailed() }; assertNotNull(f.store.read().operation)
        f.atFailureRead = { f.holder.replace(null) }; refuses { f.repo.archiveFailed() }; assertNotNull(f.store.read().operation)
        assertEquals(1, f.signCalls); assertEquals(1, f.calls.count { it.startsWith("POST ") })
    } }
    @Test fun `partial failed setup remains held across recovery without automatic claim approval`() = runBlocking { Fixture("split").use { f ->
        f.begin(); f.sign(); f.submitted += 0; f.failedOrdinals = listOf(0); f.repo.recover()
        refuses { f.repo.archiveFailed() }; refuses { f.repo.review(1) }; refuses { f.repo.submit(0) }
        assertNotNull(f.store.read().operation); assertEquals(1, f.signCalls); assertEquals(1, f.calls.count { it.startsWith("POST ") })
    } }

    @Test fun `first observed failure during archive requires another explicit action after durable recovery`() = runBlocking { Fixture().use { f ->
        f.begin(); f.sign(); f.submitted += 0; f.failedOrdinals = listOf(0)
        refuses { f.repo.archiveFailed() }; assertNotNull(f.store.read().operation!!.failure); assertNull(f.repo.archived(f.p.idempotencyKey))
        f.repo.archiveFailed(); assertNull(f.store.read().operation); assertEquals(1, f.signCalls)
    } }
    @Test fun `owned failure receipt survives obsolete actor while its old view cannot publish or archive`() = runBlocking { Fixture().use { f ->
        f.begin(); f.sign(); f.submitted += 0; f.failedOrdinals = listOf(0)
        f.atFailureRead = { f.holder.replace(null) }; refuses { f.repo.recover() }
        assertNotNull(f.store.read().operation!!.failure); assertNull(f.repo.state.value.journal!!.operation!!.failure)
        refuses { f.repo.archiveFailed() }; assertNotNull(f.store.read().operation)
    } }

    @Test fun `S3 failure HTTP error drains nested positive original custody even after the actor retires`() = runBlocking {
        for (retired in listOf(false, true)) Fixture().use { f ->
            f.begin(); f.repo.review(0); f.unknownWallet = true; refuses { f.repo.sign(0) }
            f.submitted += 0; f.failedOrdinals = listOf(0); f.failureStatus = 503; f.badFailure = true
            if (retired) f.atFailureRead = { f.holder.replace(null) }
            refuses { f.repo.archiveFailed() }; val op = f.store.read().operation!!
            assertNotNull(op.transactions.single().signed); assertTrue(op.failureObserved); assertTrue(op.unattributedObserved)
            assertNull(op.failure); assertNotNull(f.store.read().operation)
        }
    }
    @Test fun `S3 failure wire roster drains valid claim1 after bad setup0 before outer actor refusal`() = runBlocking {
        for (wrongActor in listOf(false, true)) Fixture("split").use { f ->
            f.begin(); f.stage(0); f.repo.review(1); f.unknownWallet = true; refuses { f.repo.sign(1) }
            f.submitted += 1; f.failedOrdinals = listOf(1); f.badFailureWire = true; f.badActor = wrongActor
            refuses { f.repo.archiveFailed() }; val op = f.store.read().operation!!
            assertNotNull(op.transactions.last().signed); assertTrue(op.failureObserved); assertTrue(op.unattributedObserved); assertNull(op.failure)
        }
    }

}
