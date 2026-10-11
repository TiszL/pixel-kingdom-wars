package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsContinuationRepositoryTest {
    private class Memory : SecretStore { var value: String? = null; var fail = false; var afterWrite: () -> Unit = {}; override fun read() = value
        override fun write(value: String) { if (fail) throw IOException("storage unavailable"); this.value = value; afterWrite() }; override fun clear() = error("No clearing") }
    private class F : MiningTaxClaimsPorts, java.io.Closeable {
        val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-continuation.json")).readText()).jsonObject
        val envelope = MiningTaxClaimsContinuationEnvelope.from(raw); val c = envelope.continuation!!; val p = c.parentPreparation
        val setup = MiningTaxClaimsRecoveryEnvelope(p.wallet, p.idempotencyKey, p.claimId, "setup", p, listOf(c.parentWire), c.parentSetup, p.preparedAt)
        val rules = MiningTaxClaimsSigningPolicy(Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-journal-fixtures.json")).readText()).jsonObject.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
        val pins = MiningTaxClaimsSigningTrust(p.identity.genesisHash, p.identity.programId, p.identity.configAddress, p.identity.keepMint, p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
        val disk = Memory(); val server = MockWebServer(); val client: OkHttpClient; val identity: StarterIdentity; val jar: SessionCookieJar
        val store: MiningTaxClaimsStore; override val transport: MiningTaxClaimsTransport; var repo: MiningTaxClaimsRepository
        var allowed = true; var provider = true; var current = true; var postMode = "ok"; var linked = false; var keyCalls = 0
        var beforeGet: suspend (String) -> Unit = {}; var beforePost: suspend () -> Unit = {}; var badLink = false
        val calls = java.util.Collections.synchronizedList(mutableListOf<String>()); val requests = mutableListOf<MiningTaxClaimsContinuationRequest>()
        init {
            val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
            val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build(); val trusted = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
            client = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trusted.sslSocketFactory(), trusted.trustManager).build()
            server.protocols = listOf(Protocol.HTTP_1_1); server.useHttps(serverTls.sslSocketFactory(), false); server.start()
            identity = StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", p.wallet); jar = SessionCookieJar(server.url("/"), Memory())
            store = MiningTaxClaimsStore(disk, identity, pins, rules)
            transport = MiningTaxClaimsTransport(MiningTaxClaimsHttpPort(identity, jar, jar.sessionToken(), "test", client)) { allowed }
            repo = MiningTaxClaimsRepository(store, this)
            server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = runBlocking {
                    val path = requireNotNull(request.path); calls += "${request.method} $path"
                    if (request.method == "GET") beforeGet(path)
                    val selected = if (path.endsWith(c.childPreparation.idempotencyKey)) c.childPreparation else p
                    val recovery = if (selected == p) setup else MiningTaxClaimsRecoveryEnvelope(p.wallet, selected.idempotencyKey, selected.claimId, "prepared", selected, emptyList(), null, selected.preparedAt)
                    when {
                        path.contains("/continue/") -> {
                            check(store.read().operation!!.continuation!!.attempted)
                            requests += MiningTaxClaimsContinuationRequest.from(Json.parseToJsonElement(request.body.readUtf8()).jsonObject)
                            beforePost()
                            if (postMode == "refuse") MockResponse().setResponseCode(409).setBody("{\"error\":\"NOT_EXPIRED\"}")
                            else { if (postMode != "lostBefore") linked = true
                                if (postMode.startsWith("lost")) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) else response(link()) }
                        }
                        path.contains("/continuations/") -> response(link())
                        path.contains("/prepare/by-key/") -> response(Json.encodeToJsonElement(MiningTaxClaimsPreparationEnvelope.serializer(), MiningTaxClaimsPreparationEnvelope(p.wallet, selected.idempotencyKey, "prepared", selected, selected.preparedAt)).jsonObject)
                        path.contains("/failures/") -> response(Json.encodeToJsonElement(MiningTaxClaimsFailureEnvelope.serializer(), MiningTaxClaimsFailureEnvelope(recovery, emptyList())).jsonObject)
                        else -> response(Json.encodeToJsonElement(MiningTaxClaimsRecoveryEnvelope.serializer(), recovery).jsonObject)
                    }
                }
            }
        }
        fun response(v: JsonObject) = MockResponse().setBody(v.toString())
        fun link(): JsonObject = if (!linked) JsonObject(raw + mapOf("status" to JsonPrimitive("unknown"), "continuation" to JsonNull)) else if (!badLink) raw else JsonObject(raw + ("wallet" to JsonPrimitive(p.identity.keepMint)))
        suspend fun seed() {
            store.begin(store.read(), MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps), 256); store.prepareAttempt(store.read()); store.acceptPreparation(p.idempotencyKey, p)
            store.signingAttempt(store.read(), 0); store.acceptSigned(p.idempotencyKey, 0, Base64.getEncoder().encodeToString(c.parentWire.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()))
            store.acceptRecovery(p.idempotencyKey, 0, Json.encodeToJsonElement(MiningTaxClaimsRecoveryEnvelope.serializer(), setup)); repo.open()
        }
        fun restart() = MiningTaxClaimsRepository(MiningTaxClaimsStore(disk, identity, pins, rules), this).also { repo = it }
        override fun capture(newAction: Boolean): () -> Unit = { check(current); if (newAction) check(allowed && provider) }
        override fun trust() = pins
        override fun policy() = rules
        override fun totalSpots() = 256
        override fun key(): String { keyCalls++; return c.childPreparation.idempotencyKey }
        override fun clockMs() = 0L
        override suspend fun live(preparation: MiningTaxClaimsPreparation, ordinal: Int, guard: () -> Unit) = error("Unsigned continuation cannot require signing admission")
        override val wallet: MiningTaxClaimsWallet get() = error("Unsigned continuation cannot access a wallet")
        override fun close() { server.close(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private suspend fun refuses(block: suspend () -> Unit) { val r = runCatching { block() }; if (r.exceptionOrNull() is AssertionError) throw r.exceptionOrNull()!!; assertTrue(r.isFailure) }
    @Test fun `one explicit unsigned POST and fresh parent failure link GETs precede atomic child adoption`() = runBlocking { F().use { f ->
        f.seed(); f.repo.prepareContinuation(f.c.childPreparation.caps); assertNotNull(f.store.read().operation!!.continuation!!.envelope)
        val before = f.calls.size; f.allowed = false; f.provider = false; f.repo.activateContinuation()
        val after = f.calls.drop(before); assertTrue(after.all { it.startsWith("GET ") }); assertTrue(after.any { it.contains("/by-key/${f.p.idempotencyKey}") }); assertTrue(after.any { it.contains("/failures/") }); assertTrue(after.any { it.contains("/continuations/") })
        assertEquals(f.c.childPreparation.idempotencyKey, f.store.read().operation!!.request.idempotencyKey); assertTrue(f.store.read().operation!!.transactions.isEmpty())
        assertNull(f.store.archived(f.p.idempotencyKey)!!.operation.settlement); assertEquals(1, f.requests.size); assertEquals(1, f.keyCalls)
        refuses { f.repo.sign(0) }
    } }
    @Test fun `lost committed reply recovers only by GET and explicit resume with known link does not POST`() = runBlocking { F().use { f ->
        f.seed(); f.postMode = "lostAfter"; refuses { f.repo.prepareContinuation(f.c.childPreparation.caps) }; val before = f.calls.size
        f.restart().open(); assertNotNull(f.store.read().operation!!.continuation!!.envelope); assertTrue(f.calls.drop(before).all { it.startsWith("GET ") })
        f.repo.resumeContinuation(); assertEquals(1, f.requests.size); f.repo.activateContinuation(); assertEquals(1, f.keyCalls)
    } }
    @Test fun `unknown lost or not expired preparation resumes only the same durable intent after fresh GETs`() = runBlocking {
        for (mode in listOf("lostBefore", "refuse")) F().use { f ->
            f.seed(); f.postMode = mode; refuses { f.repo.prepareContinuation(f.c.childPreparation.caps) }; val first = f.store.read().operation!!.continuation!!; val before = f.calls.size
            f.restart().open(); assertTrue(f.calls.drop(before).all { it.startsWith("GET ") }); assertEquals(1, f.requests.size)
            refuses { f.repo.prepareContinuation(f.c.childPreparation.caps) }; f.postMode = "ok"; f.repo.resumeContinuation()
            assertEquals(listOf(first.request, first.request), f.requests); assertEquals(1, f.keyCalls); assertNotNull(f.store.read().operation!!.continuation!!.envelope)
        }
    }
    @Test fun `claim approval or late positive evidence prevents initial or resumed unsigned POST`() = runBlocking { F().use { f ->
        f.seed(); f.store.signingAttempt(f.store.read(), 1); refuses { f.repo.prepareContinuation(f.c.childPreparation.caps) }; assertTrue(f.requests.isEmpty())
    }; F().use { f ->
        f.seed(); f.postMode = "refuse"; refuses { f.repo.prepareContinuation(f.c.childPreparation.caps) }; f.store.observeSettlementKey(f.p.idempotencyKey, 1)
        refuses { f.repo.resumeContinuation() }; assertEquals(1, f.requests.size)
    } }
    @Test fun `late parent observation during fresh adoption reads preserves parent and bound child intent`() = runBlocking { F().use { f ->
        f.seed(); f.repo.prepareContinuation(f.c.childPreparation.caps)
        f.beforeGet = { if (it.contains("/continuations/")) f.store.observeSettlementKey(f.p.idempotencyKey, 1) }
        refuses { f.repo.activateContinuation() }; assertEquals(f.p.idempotencyKey, f.store.read().operation!!.request.idempotencyKey); assertNotNull(f.store.read().operation!!.continuation!!.envelope)
    } }
    @Test fun `retired session still drains committed original link but cannot activate or issue another POST`() = runBlocking { F().use { f ->
        f.seed(); f.beforePost = { f.current = false }; refuses { f.repo.prepareContinuation(f.c.childPreparation.caps) }
        assertNotNull(f.store.read().operation!!.continuation!!.envelope); assertEquals(f.p.idempotencyKey, f.store.read().operation!!.request.idempotencyKey)
        refuses { f.repo.activateContinuation() }; assertEquals(1, f.requests.size)
    } }
    @Test fun `malformed adjacent link preserves setup bytes and permanent unknown hold`() = runBlocking { F().use { f ->
        f.seed(); f.badLink = true; refuses { f.repo.prepareContinuation(f.c.childPreparation.caps) }
        val op = f.store.read().operation!!; assertNotNull(op.transactions.single().signed); assertTrue(op.unattributedObserved); assertTrue(op.continuationObserved)
        f.badLink = false; f.repo.resumeContinuation(); assertNotNull(f.store.read().operation!!.continuation!!.envelope)
        assertTrue(f.store.read().operation!!.unattributedObserved); refuses { f.repo.activateContinuation() }; assertEquals(1, f.requests.size)
    } }
    @Test fun `crashed unattempted continuation intent remains GET only until explicit same consent resume`() = runBlocking { F().use { f ->
        f.seed(); val child = MiningTaxClaimsContinuationRequest(f.c.childPreparation.idempotencyKey, f.c.childPreparation.caps)
        f.store.beginContinuation(f.store.read(), child); f.restart().open(); assertTrue(f.requests.isEmpty())
        f.repo.resumeContinuation(); assertEquals(listOf(child), f.requests); assertEquals(0, f.keyCalls)
    } }
    @Test fun `same or other key hold after durable attempt prevents the final outgoing continuation POST`() = runBlocking {
        for (other in listOf(false, true)) F().use { f ->
            f.seed(); f.disk.afterWrite = {
                val op = Json.parseToJsonElement(requireNotNull(f.disk.value)).jsonObject.getValue("operation").jsonObject
                if ((op["continuation"] as? JsonObject)?.get("attempted") == JsonPrimitive(true)) {
                    f.disk.afterWrite = {}; f.store.observeSettlementKey(if (other) f.p.claimId else f.p.idempotencyKey, 1)
                }
            }
            refuses { f.repo.prepareContinuation(f.c.childPreparation.caps) }; assertTrue(f.requests.isEmpty())
            assertTrue(f.store.read().operation!!.continuation!!.attempted)
        }
    }
}
