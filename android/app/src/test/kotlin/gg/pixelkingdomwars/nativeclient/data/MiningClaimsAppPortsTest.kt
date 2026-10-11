package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlin.coroutines.CoroutineContext
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningClaimsAppPortsTest {
    private val json = Json { encodeDefaults = true }
    private fun catalogue() = buildJsonObject { putJsonObject("constants") { putJsonObject("TOKEN") { put("decimals", 9) }; putJsonObject("PHASE_E_MINING_CLAIM_QUOTE") { put("version", 1); put("ttlSec", 120) } } }
    private inline fun <reified T> raw(value: T) = json.encodeToJsonElement(value).jsonObject
    private class Fixture {
        val wire = MiningClaimsWalletFixture(); val p = wire.preparation; val holder = testHolder(); val session = signedIn(holder, p.wallet)
        val store = MiningClaimsStore(MemoryStore(), StarterIdentity(session.origin.trimEnd('/'), "devnet", p.wallet))
        var catalogue: JsonObject? = MiningClaimsAppPortsTest().catalogue(); var pins: MiningClaimSigningTrust? = wire.trust
        var lifecycle = MiningClaimsLifecycle(true, true, 1, true, true, "content-v1", false)
        var afterResponse: () -> Unit = {}; var foreign = false; var posts = 0; var signs = 0; var reads = 0; var genesis = wire.trust.genesisHash; var height = p.transactions.single().lastValidBlockHeight
        var genesisRead: suspend () -> String = { genesis }; var heightReads = 0
        val gate = MiningClaimsRpcGate()
        fun seed() { var j = store.begin(store.read(), p.idempotencyKey, wire.policy); j = store.prepareAttempt(j); store.acceptPreparation(p.idempotencyKey, p) }
        fun status() = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), p.wallet, "shardkeep-economy", p.identity.programId, p.identity.keepMint,
            "ready", null, "1", "80", "0", "80", 9, 200, "7200", "7200", true, true, true, false, p.serverNow)
        val api = object : ApiClient by FakeApiClient() {
            override suspend fun getMiningClaim(path: String, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard(); reads++
                val raw = when (path) {
                    "/claims/mining/status" -> Json.encodeToJsonElement(MiningClaimStatusView.serializer(), status()).jsonObject
                    "/claims/mining/prepare/by-key/${p.idempotencyKey}" -> Json.encodeToJsonElement(MiningClaimPreparationEnvelope.serializer(), MiningClaimPreparationEnvelope(
                        if (foreign) "11111111111111111111111111111111" else p.wallet, p.idempotencyKey, "prepared", p, p.serverNow)).jsonObject
                    else -> Json.encodeToJsonElement(MiningClaimView.serializer(), MiningClaimView(1, p.wallet, p.claimId, "prepared", "pending", null, null,
                        listOf(MiningClaimLanding(0, "combined", null, "pending", null, null, null)), p.serverNow, false)).jsonObject
                }
                afterResponse(); evidence?.invoke(raw); guard(); return raw
            }
            override suspend fun postMiningClaim(path: String, body: JsonObject, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?, refusal: ((ApiException) -> Unit)?): JsonObject {
                guard(); posts++
                val raw = if (path.endsWith("prepare")) Json.encodeToJsonElement(MiningClaimPreparationView.serializer(), p).jsonObject else
                    Json.encodeToJsonElement(MiningClaimSubmitResponse.serializer(), MiningClaimSubmitResponse(p.claimId, wire.saved.signature, p.serverNow, "held")).jsonObject
                afterResponse(); evidence?.invoke(raw); guard(); return raw
            }
        }
        fun ports(timeout: Long = 30000) = MiningClaimsAppPorts(session, holder, api, store, { catalogue }, { pins }, { lifecycle },
            object : MiningClaimsRpcReads { override suspend fun genesisHash() = genesisRead(); override suspend fun finalizedBlockHeight(): Long { heightReads++; return height } }, gate,
            signer = { prepared, guard, retain -> signs++; retain(verifyMiningClaimSavedWire(p, wire.saved.wire)); afterResponse(); guard(); assertEquals(p.wallet, prepared.wallet) }, monotonicMs = { 10 }, timeoutMs = timeout)
    }
    private suspend fun refuses(block: suspend () -> Unit) { try { block(); fail("Expected refusal") } catch (e: AssertionError) { throw e } catch (_: Exception) {} }
    @Test fun `policy reads canonical numeric catalogue fields and has no fallback tuning`() {
        assertEquals(MiningClaimsProtocolPolicy(9, 1, 120), miningClaimsPolicy(catalogue())); assertNull(miningClaimsPolicy(null))
        for (bad in listOf(JsonPrimitive("9"), JsonPrimitive(-1), JsonNull)) {
            val c = catalogue().getValue("constants").jsonObject
            assertNull(miningClaimsPolicy(JsonObject(mapOf("constants" to JsonObject(c + ("TOKEN" to buildJsonObject { put("decimals", bad) }))))))
        }
    }
    @Test fun `new capture freezes account content view independent trust policy and admission without a base dependency`() = runBlocking {
        val f = Fixture(); val ports = f.ports(); val guard = ports.capture(true); guard()
        for (changed in listOf(f.lifecycle.copy(active = false), f.lifecycle.copy(visible = false), f.lifecycle.copy(viewEpoch = 2), f.lifecycle.copy(actionsAllowed = false),
            f.lifecycle.copy(contentReady = false), f.lifecycle.copy(contentIdentity = "content-v2"), f.lifecycle.copy(battleActive = true))) {
            val original = f.lifecycle; f.lifecycle = changed; refuses { guard() }; f.lifecycle = original
        }
        f.pins = f.wire.trust.copy(keepMint = "11111111111111111111111111111111"); refuses { guard() }; f.pins = f.wire.trust
        f.catalogue = null; refuses { guard() }; f.catalogue = catalogue()
        signedIn(f.holder, f.p.wallet); refuses { guard() }; f.gate.close()
    }
    @Test fun `historical recovery uses frozen policy while catalogue trust and current gameplay admission are unavailable`() = runBlocking {
        val f = Fixture(); f.seed(); f.catalogue = null; f.pins = null; f.lifecycle = f.lifecycle.copy(actionsAllowed = false, contentReady = false, battleActive = true)
        val ports = f.ports(); val guard = ports.capture(false); var receipt: MiningClaimPreparationView? = null
        ports.preparation(f.p.idempotencyKey, guard) { receipt = it.receipt }; ports.claim(f.p.claimId, guard) {}; ports.status(guard)
        assertEquals(f.p, receipt); refuses { ports.capture(true) }; assertEquals(0, f.posts); assertEquals(0, f.signs); f.gate.close()
    }
    @Test fun `owned parsed evidence is retained before stale view refusal while foreign or wrong keys cannot reach callback`() = runBlocking {
        val f = Fixture(); f.seed(); val ports = f.ports(); val guard = ports.capture(false); var receipts = 0
        f.afterResponse = { f.lifecycle = f.lifecycle.copy(viewEpoch = 2) }
        refuses { ports.preparation(f.p.idempotencyKey, guard) { receipts++ } }; assertEquals(1, receipts)
        val next = ports.capture(false); f.foreign = true; f.afterResponse = {}
        refuses { ports.preparation(f.p.idempotencyKey, next) { receipts++ } }; assertEquals(1, receipts)
        val reads = f.reads; refuses { ports.preparation("00000000-0000-4000-8000-000000000099", next) {} }; assertEquals(reads, f.reads); f.gate.close()
    }
    @Test fun `live checks require exact genesis and unexpired safely represented finalized height and never send`() = runBlocking {
        val f = Fixture(); f.seed(); val ports = f.ports(); val guard = ports.capture(true)
        ports.live(f.p, guard); f.genesis = "11111111111111111111111111111111"; refuses { ports.live(f.p, guard) }
        f.genesis = f.wire.trust.genesisHash
        for (height in listOf(-1L, 9007199254740992L, f.height + 1)) { f.height = height; refuses { ports.live(f.p, guard) } }
        assertEquals(0, f.posts); assertEquals(0, f.signs); f.gate.close()
    }
    @Test fun `shared RPC fence survives timeout and new port construction until uncooperative source drains`() = runBlocking {
        val f = Fixture(); f.seed(); val waiting = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.genesisRead = { withContext(NonCancellable) { waiting.complete(Unit); release.await(); f.genesis } }
        val first = f.ports(25); val guard = first.capture(true)
        val job = async { refuses { first.live(f.p, guard) } }; waiting.await(); job.await()
        val next = f.ports(25); refuses { next.capture(true) }; val history = next.capture(false); next.claim(f.p.claimId, history) {}
        refuses { next.prepare(MiningClaimPrepareRequest(f.p.idempotencyKey), guard, {}, {}) }; assertEquals(0, f.posts)
        release.complete(Unit); withTimeout(2000) { while (runCatching { f.gate.requireIdle() }.isFailure) delay(5) }
        assertEquals(0, f.heightReads); f.genesisRead = { f.genesis }; next.live(f.p, next.capture(true)); assertEquals(1, f.heightReads); f.gate.close()
    }
    @Test fun `cancel before dispatcher executes the RPC body releases only the completed matching flight`() = runBlocking {
        val queue = java.util.ArrayDeque<Runnable>()
        val dispatcher = object : CoroutineDispatcher() { override fun dispatch(context: CoroutineContext, block: Runnable) { queue.add(block) } }
        val gate = MiningClaimsRpcGate(dispatcher); var entered = false
        try {
            val task = launch(start = CoroutineStart.UNDISPATCHED) { gate.run(30000, {}) { entered = true } }
            assertEquals(1, queue.size); assertFalse(entered)
            task.cancelAndJoin()
            while (queue.isNotEmpty()) queue.removeFirst().run()
            gate.requireIdle(); assertFalse("A cancelled queued read must never enter its RPC body", entered)
            val next = launch(start = CoroutineStart.UNDISPATCHED) { gate.run(30000, {}) { entered = true } }
            while (queue.isNotEmpty()) queue.removeFirst().run()
            next.join(); assertTrue(entered); gate.requireIdle()
        } finally { gate.close() }
    }
    @Test fun `sign callback commits late evidence before lifecycle checks and submit accepts only saved exact wire`() = runBlocking {
        val f = Fixture(); f.seed(); val ports = f.ports(); val guard = ports.capture(true); f.store.signingAttempt(f.store.read())
        f.afterResponse = { f.lifecycle = f.lifecycle.copy(viewEpoch = 2) }
        refuses { ports.sign(f.wire.prepared(), guard) { f.store.acceptSigned(f.p.idempotencyKey, it.wire) } }
        assertEquals(f.wire.saved, f.store.read().operation?.signed); assertEquals(0, f.posts)
        f.afterResponse = {}; val current = ports.capture(true); f.store.submitAttempt(f.store.read())
        refuses { ports.submit(MiningClaimSubmitRequest(f.p.claimId, "A".repeat(88)), current) }; assertEquals(0, f.posts)
        ports.submit(MiningClaimSubmitRequest(f.p.claimId, f.wire.saved.wire), current); assertEquals(1, f.posts); f.gate.close()
    }
    @Test fun `RPC adapter asks for finalized height rather than a confirmed estimate`() = runBlocking {
        val methods = mutableListOf<String>(); val f = Fixture()
        val rpc = SolanaMiningClaimsRpcReads(SolanaRpc { body ->
            methods += body.getValue("method").jsonPrimitive.content
            if (methods.last() == "getBlockHeight") assertEquals("finalized", body.getValue("params").jsonArray.single().jsonObject.getValue("commitment").jsonPrimitive.content)
            buildJsonObject { put("result", if (methods.last() == "getGenesisHash") JsonPrimitive(f.genesis) else JsonPrimitive(100)) }
        })
        assertEquals(f.genesis, rpc.genesisHash()); assertEquals(100L, rpc.finalizedBlockHeight()); assertEquals(listOf("getGenesisHash", "getBlockHeight"), methods); f.gate.close()
    }
}
