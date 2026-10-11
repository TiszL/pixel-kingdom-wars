package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.Closeable
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Test-only cluster rebinding changes public identity assertions, never signed bytes.
 * Production pins must be supplied independently and are null by default. */
internal class MiningTaxAppFixture(kind: String = "combined") : Closeable {
    private val json = Json { encodeDefaults = true }
    private val raw = json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax-journal-fixtures.json")).readText()).jsonObject
    private fun network(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> JsonObject(value.mapValues { (k, v) -> if (k == "genesisHash") JsonPrimitive(SolanaCluster.DEVNET.genesisHash) else network(v) })
        is JsonArray -> JsonArray(value.map(::network))
        else -> value
    }
    val recovery = MiningTaxClaimsRecoveryEnvelope.from(network(raw.getValue("recoveries").jsonObject.getValue(kind)).jsonObject)
    val setup = MiningTaxClaimsRecoveryEnvelope.from(network(raw.getValue("recoveries").jsonObject.getValue("setup")).jsonObject)
    val p = requireNotNull(recovery.preparation)
    val policy = MiningTaxClaimsSigningPolicy(raw.getValue("policy").jsonObject.getValue("daySec").jsonPrimitive.long)
    val independentPins = MiningTaxClaimsSigningTrust(p.source.genesisHash, p.source.programId, p.identity.configAddress, p.identity.keepMint,
        p.identity.reserveOwner, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256)
    private class Memory : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    val server = MockWebServer(); val client: OkHttpClient; val jar: SessionCookieJar; val identity: StarterIdentity
    val holder = AccountSessionHolder(dispatcher = Dispatchers.Unconfined); val session: AccountSession; val store: MiningTaxClaimsStore
    val gate = MiningClaimsRpcGate(); var enabled = true; var pins: MiningTaxClaimsSigningTrust? = independentPins
    var page = MiningTaxClaimsLifecycle(true, true, 1, true, true, "fixture-content", false)
    val totalSpots = json.parseToJsonElement(requireNotNull(javaClass.getResource("/realm-sale-repository-fixture.json")).readText()).jsonObject.getValue("policy").jsonObject.getValue("totalSpots").jsonPrimitive.int
    var content: JsonObject? = buildJsonObject { putJsonObject("constants") {
        putJsonObject("PHASE_E_MINING_PUBLICATION") { put("daySec", policy.daySec) }
        putJsonObject("PHASE_E_POLICY") { putJsonObject("seekerIsland") { put("totalSpots", totalSpots) } }
        putJsonObject("TOKEN") { put("decimals", 9) }
    } }
    var now = 0L; var height = p.lastValidBlockHeight; var reviewHeight = p.blockHeight; var genesis = independentPins.genesisHash
    var reads = 0; var badSetupPaid = false; var badCaps = false; var prepared = false
    var afterReview: () -> Unit = {}; var genesisRead: suspend () -> String = { genesis }
    init {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build(); val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        client = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        server.protocols = listOf(Protocol.HTTP_1_1); server.useHttps(tls.sslSocketFactory(), false); server.start()
        identity = StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", p.wallet)
        jar = SessionCookieJar(server.url("/"), Memory()); session = AccountSession(p.wallet, identity.origin, jar.sessionToken()); holder.replace(session)
        store = MiningTaxClaimsStore(Memory(), identity, independentPins, policy)
        server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = requireNotNull(request.path)
                val body = if (path.contains("/review/by-key/")) review(path.last().digitToInt()).also { afterReview() } else if (path.contains("/claims/mining-tax/by-key/") || path.contains("/claims/mining-tax/failures/by-key/")) {
                    json.encodeToJsonElement(MiningTaxClaimsRecoveryEnvelope.serializer(), MiningTaxClaimsRecoveryEnvelope(p.wallet, p.idempotencyKey,
                        if (prepared) p.claimId else null, if (prepared) "prepared" else "unknown", if (prepared) p else null, emptyList(), null, p.preparedAt)).jsonObject.let { recovery ->
                            if (path.contains("/failures/by-key/")) buildJsonObject { put("recovery", recovery); put("failures", JsonArray(emptyList())) } else recovery
                        }
                } else {
                    if (request.method == "POST") prepared = true
                    json.encodeToJsonElement(MiningTaxClaimsPreparationEnvelope.serializer(), MiningTaxClaimsPreparationEnvelope(p.wallet, p.idempotencyKey,
                        if (prepared) "prepared" else "unknown", if (prepared) p else null, p.preparedAt)).jsonObject
                }
                return MockResponse().setBody(body.toString())
            }
        }
    }
    private fun time(seconds: Long) = DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.parse(p.preparedAt).plusSeconds(seconds))
    fun review(ordinal: Int): JsonObject {
        val tx = p.transactions[ordinal]; val paid = if (ordinal == 1) requireNotNull(setup.settlement).receipt else null
        val fee = if (badCaps) (p.caps.maxFeeLamports.toBigInteger() + java.math.BigInteger.ONE).toString() else tx.feeLamports
        val selected = gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsReview(p.wallet, p.idempotencyKey, p.claimId, ordinal.toLong(), "ready", tx.messageSha256, p.blockhash,
            p.preparedAt, p.expiresAt, time(1), fee, tx.rentLamports, (fee.toBigInteger() + tx.rentLamports.toBigInteger()).toString(),
            if (badSetupPaid) "0" else paid?.feeLamports ?: "0", paid?.rentLamports ?: "0",
            MiningTaxClaimsReviewSource(p.source.genesisHash, p.source.programId, p.source.reviewedDeploymentSlot, p.source.reviewedProgramDataSha256,
                maxOf(p.source.snapshotSlot, p.source.blockhashSlot) + 1, maxOf(p.source.snapshotSlot, p.source.blockhashSlot) + 1, reviewHeight, p.lastValidBlockHeight), false, false, false)
        return JsonObject(json.encodeToJsonElement(MiningTaxClaimsReviewResponse.serializer(), MiningTaxClaimsReviewResponse(p.wallet, p.idempotencyKey, ordinal.toLong(), "ready", selected, serverNow = time(2))).jsonObject - "reason")
    }
    val wallet get() = MiningTaxClaimsWallet(session, holder, identity.origin, SolanaCluster.DEVNET, { false }, { null }, null)
    fun ports(timeout: Long = 30000, productionDefaultPins: Boolean = false, apiOrigin: String = identity.origin, cluster: SolanaCluster = SolanaCluster.DEVNET): MiningTaxClaimsAppPorts {
        val rpc = object : MiningClaimsRpcReads { override suspend fun genesisHash() = genesisRead().also { reads++ }; override suspend fun finalizedBlockHeight() = height.also { reads++ } }
        val bound = GameApi.withTransport(identity.origin, jar, "fixture", client).miningTaxClaimsPort(identity, session.token)
        return if (productionDefaultPins) MiningTaxClaimsAppPorts(session, holder, apiOrigin, cluster, bound, store, { content }, { enabled }, { page }, wallet, rpc,
            gate, { now }, timeoutMs = timeout)
        else MiningTaxClaimsAppPorts(session, holder, apiOrigin, cluster, bound, store, { content }, { enabled }, { page }, wallet, rpc,
            gate, { now }, independentPins = { pins }, timeoutMs = timeout)
    }
    suspend fun seed() { store.begin(store.read(), MiningTaxClaimsPrepareRequest(p.idempotencyKey, p.round, p.spot, p.caps), totalSpots); store.prepareAttempt(store.read()); store.acceptPreparation(p.idempotencyKey, p) }
    suspend fun setupPaid() {
        store.signingAttempt(store.read(), 0); val w = setup.wires.first()
        store.acceptSigned(p.idempotencyKey, 0, java.util.Base64.getEncoder().encodeToString(w.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()))
        store.acceptRecovery(p.idempotencyKey, 0, json.encodeToJsonElement(MiningTaxClaimsRecoveryEnvelope.serializer(), setup.copy(wires = setup.wires.take(1))))
    }
    override fun close() { gate.close(); server.close(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
}

class MiningTaxClaimsAppPortsTest {
    private suspend fun refuses(block: suspend () -> Unit) { val result = runCatching { block() }; if (result.exceptionOrNull() is AssertionError) throw result.exceptionOrNull()!!; assertTrue(result.isFailure) }
    @Test fun `canonical content owns numeric policy with no string coercion or fallback`() { MiningTaxAppFixture().use { f ->
        val policy = requireNotNull(miningTaxClaimsPolicy(f.content)); assertEquals(f.policy.daySec, policy.daySec); assertEquals(f.totalSpots, policy.totalSpots)
        assertNull(miningTaxClaimsPolicy(null))
        val constants = f.content!!.getValue("constants").jsonObject
        for (bad in listOf(JsonPrimitive("86400"), JsonPrimitive(0), JsonPrimitive(-1), JsonNull)) {
            val broken = JsonObject(constants + ("PHASE_E_MINING_PUBLICATION" to buildJsonObject { put("daySec", bad) }))
            assertNull(miningTaxClaimsPolicy(buildJsonObject { put("constants", broken) }))
        }
    } }
    @Test fun `production pins default absent while paused providerless history retains its exact session`() = runBlocking { MiningTaxAppFixture().use { f ->
        val port = f.ports(productionDefaultPins = true); assertNull(port.trust()); refuses { port.capture(true) }
        f.content = null; f.enabled = false; f.page = f.page.copy(actionsAllowed = false, contentReady = false, battleActive = true)
        port.capture(false)(); f.jar.beginAuthentication(); refuses { port.capture(false) }; assertEquals(0, f.reads)
    } }
    @Test fun `constructor binds actor API origin cluster and session token before any transport request`() = runBlocking { MiningTaxAppFixture().use { f ->
        refuses { f.ports(apiOrigin = "https://other.test") }; refuses { f.ports(cluster = SolanaCluster.MAINNET) }
        f.jar.beginAuthentication(); refuses { f.ports() }; assertEquals(0, f.server.requestCount)
    } }
    @Test fun `new action capture rejects flags visibility epoch content battle pins and account drift`() = runBlocking { MiningTaxAppFixture().use { f ->
        val port = f.ports(); val guard = port.capture(true)
        val original = f.page
        for (page in listOf(original.copy(active = false), original.copy(visible = false), original.copy(viewEpoch = 2), original.copy(actionsAllowed = false), original.copy(contentReady = false), original.copy(contentIdentity = "other"), original.copy(battleActive = true))) {
            f.page = page; refuses { guard() }; f.page = original
        }
        f.enabled = false; refuses { guard() }; f.enabled = true; f.pins = f.independentPins.copy(reviewedProgramDataSha256 = "ab".repeat(32)); refuses { guard() }
        f.pins = f.independentPins; f.holder.replace(null); refuses { guard() }
    } }
    @Test fun `live binds original packet review before fresh network and finalized height checks`() = runBlocking { MiningTaxAppFixture().use { f ->
        f.seed(); val port = f.ports(); port.live(f.p, 0, port.capture(true)); assertEquals(1, f.server.requestCount); assertEquals(2, f.reads)
        f.genesis = f.p.identity.keepMint; refuses { port.live(f.p, 0, port.capture(true)) }; f.genesis = f.independentPins.genesisHash
        for (bad in listOf(-1L, 9_007_199_254_740_992L, f.p.lastValidBlockHeight + 1)) { f.height = bad; refuses { port.live(f.p, 0, port.capture(true)) } }
        refuses { port.live(f.p.copy(claimId = f.p.idempotencyKey), 0, port.capture(true)) }
    } }
    @Test fun `live review honors explicit caps and exact durable setup costs`() = runBlocking { MiningTaxAppFixture("split").use { f ->
        f.seed(); f.setupPaid(); val port = f.ports(); port.live(f.p, 1, port.capture(true))
        f.badSetupPaid = true; refuses { port.live(f.p, 1, port.capture(true)) }; f.badSetupPaid = false
        f.badCaps = true; refuses { port.live(f.p, 1, port.capture(true)) }; assertEquals(2, f.reads)
    } }
    @Test fun `finalized RPC height cannot regress below the original preparation`() = runBlocking { MiningTaxAppFixture().use { f ->
        f.seed(); f.height = f.p.blockHeight - 1; val port = f.ports()
        refuses { port.live(f.p, 0, port.capture(true)) }; assertEquals(2, f.reads)
    } }
    @Test fun `finalized RPC height cannot regress below a newer exact packet review`() = runBlocking { MiningTaxAppFixture().use { f ->
        f.seed(); f.reviewHeight = f.p.blockHeight + 2; f.height = f.p.blockHeight + 1; val port = f.ports()
        refuses { port.live(f.p, 0, port.capture(true)) }; assertEquals(2, f.reads)
    } }
    @Test fun `changed admission after review and expiry during RPC stop the remaining reads`() = runBlocking { MiningTaxAppFixture().use { f ->
        f.seed(); val port = f.ports(); f.afterReview = { f.enabled = false }; refuses { port.live(f.p, 0, port.capture(true)) }; assertEquals(0, f.reads)
        f.afterReview = {}; f.enabled = true; f.genesisRead = { f.now = 1_000_000; f.genesis }
        refuses { port.live(f.p, 0, port.capture(true)) }; assertEquals(1, f.reads)
    } }
    @Test fun `abandoned live read holds the shared gate across ports while history stays accessible`() = runBlocking { MiningTaxAppFixture().use { f ->
        f.seed(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.genesisRead = { withContext(NonCancellable) { entered.complete(Unit); release.await(); f.genesis } }
        val p = f.ports(25); val action = async { refuses { p.live(f.p, 0, p.capture(true)) } }; withTimeout(3000) { entered.await() }; action.await()
        val next = f.ports(25); refuses { next.capture(true) }; next.capture(false)(); release.complete(Unit)
        withTimeout(3000) { while (runCatching { f.gate.requireIdle() }.isFailure) delay(5) }; assertEquals(1, f.reads)
    } }
}
