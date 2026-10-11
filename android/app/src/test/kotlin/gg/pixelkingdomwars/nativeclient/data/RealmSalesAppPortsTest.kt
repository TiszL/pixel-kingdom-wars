package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class RealmSalesAppPortsTest {
    private fun catalogue(p: RealmSalesSavedPolicy) = buildJsonObject { putJsonObject("constants") {
        putJsonObject("PHASE_E_POLICY") { put("basisPoints", p.protocol.basisPoints); putJsonObject("seekerIsland") {
            put("totalSpots", p.protocol.totalSpots); put("kingSpots", p.kingSpots); put("realmCount", p.protocol.realmCount)
            put("paidContractsPerSpotDayMax", p.protocol.quotaMax); put("permitDurationSec", p.protocol.permitDurationSec)
            put("permitPriceLamports", p.protocol.permitPriceLamports); put("contractSellerBps", p.protocol.sellerBps); put("contractDevBps", p.protocol.developerBps)
        } }
        putJsonObject("PHASE_E_SEEKER_SALE") { put("version", p.protocol.version); put("quoteTtlSec", p.protocol.quoteTtlSec) }
        putJsonObject("PHASE_E_SEEKER_AUCTION") { put("regularRealmCount", p.regularRealmCount) }
        putJsonObject("PHASE_E_MINING_PUBLICATION") { put("daySec", p.protocol.daySec) }
    } }
    private class Fixture {
        val wire = RealmSalesWalletFixture(); val p = wire.preparation
        // Process-wide custody holds intentionally outlive a store instance. Independent
        // tests need independent origins; never clear the production hold to seed a test.
        val origin = "https://realm-ports-${java.util.UUID.randomUUID()}.test"
        val holder = testHolder()
        val session = AccountSession(p.wallet, origin,
            gg.pixelkingdomwars.nativeclient.network.SessionCookieJar(origin.toHttpUrl(), MemoryStore()).sessionToken()).also(holder::replace)
        val store = RealmSalesStore(MemoryStore(), StarterIdentity(session.origin.trimEnd('/'), "devnet", p.wallet))
        var content: JsonObject? = RealmSalesAppPortsTest().catalogue(wire.policy); var pins: RealmSaleSigningTrust? = wire.trust
        var page = RealmSalesLifecycle(true, true, 1, true, true, "content-1", false)
        var genesis = wire.trust.genesisHash; var height = p.quote.lastValidBlockHeight; var heightReads = 0; var signs = 0
        var genesisRead: suspend () -> String = { genesis }; var signed: suspend () -> Unit = {}
        val gate = RealmSalesRpcGate()
        fun ports(timeout: Long = 30000) = RealmSalesAppPorts(session, holder, FakeApiClient(), store, { content }, { pins }, { page },
            object : RealmSalesRpcReads { override suspend fun genesisHash() = genesisRead(); override suspend fun finalizedBlockHeight(): Long { heightReads++; return height } },
            gate, { prepared, guard, retain -> signs++; signed(); retain(prepared.verifySignedBase64(wire.signed.wire)); guard() }, { guard -> guard() }, { 10 }, timeout)
        suspend fun seed() {
            store.begin(store.read(), gg.pixelkingdomwars.nativeclient.realmsales.RealmSalePrepareRequest(p.idempotencyKey, p.spot, p.realm), wire.policy)
            store.prepareAttempt(store.read()); store.acceptPreparation(p.idempotencyKey, p)
        }
    }
    private suspend fun refuses(block: suspend () -> Unit) { assertTrue("Changed admission must refuse", runCatching { block() }.isFailure) }
    @Test fun `catalogue supplies every economic policy without numeric-string or fallback tuning`() {
        val f = RealmSalesWalletFixture(); val c = catalogue(f.policy)
        assertEquals(f.policy, realmSalesPolicy(c)); assertNull(realmSalesPolicy(null))
        val constants = c.getValue("constants").jsonObject
        for (value in listOf(JsonPrimitive("1"), JsonPrimitive(-1), JsonNull)) {
            val sale = constants.getValue("PHASE_E_SEEKER_SALE").jsonObject
            assertNull(realmSalesPolicy(buildJsonObject { put("constants", JsonObject(constants + ("PHASE_E_SEEKER_SALE" to JsonObject(sale + ("version" to value))))) }))
        }
    }
    @Test fun `new actions freeze account view policy independent pins and content identity`() = runBlocking {
        val f = Fixture(); val ports = f.ports(); val guard = ports.capture(true); guard()
        for (page in listOf(f.page.copy(active = false), f.page.copy(visible = false), f.page.copy(viewEpoch = 2), f.page.copy(actionsAllowed = false),
            f.page.copy(contentReady = false), f.page.copy(contentIdentity = "content-2"), f.page.copy(battleActive = true))) {
            val old = f.page; f.page = page; refuses { guard() }; f.page = old
        }
        f.pins = f.wire.trust.copy(revision = "changed"); refuses { guard() }; f.pins = f.wire.trust
        f.content = null; refuses { guard() }; f.content = catalogue(f.wire.policy)
        signedIn(f.holder, f.p.wallet); refuses { guard() }; f.gate.close()
    }
    @Test fun `historical capture remains possible without pins content or current gameplay admission`() = runBlocking {
        val f = Fixture(); f.content = null; f.pins = null; f.page = f.page.copy(actionsAllowed = false, contentReady = false, battleActive = true)
        val ports = f.ports(); ports.capture(false)(); refuses { ports.capture(true) }; assertEquals(0, f.signs); f.gate.close()
    }
    @Test fun `live reads require original saved preparation independent network and finalized unexpired height`() = runBlocking {
        val f = Fixture(); f.seed(); val ports = f.ports(); val guard = ports.capture(true); ports.live(f.p, guard)
        f.genesis = "11111111111111111111111111111111"; refuses { ports.live(f.p, guard) }; f.genesis = f.wire.trust.genesisHash
        for (bad in listOf(-1L, 9007199254740992L, f.p.quote.lastValidBlockHeight + 1)) { f.height = bad; refuses { ports.live(f.p, guard) } }
        f.height = f.p.quote.lastValidBlockHeight
        refuses { ports.live(f.p.copy(idempotencyKey = "00000000-0000-4000-8000-000000000099"), guard) }
        assertEquals(0, f.signs); f.gate.close()
    }
    @Test fun `RPC timeout holds shared gate until abandoned read drains but permits historical capture`() = runBlocking {
        val f = Fixture(); f.seed(); val started = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.genesisRead = { withContext(NonCancellable) { started.complete(Unit); release.await(); f.genesis } }
        val ports = f.ports(25); val guard = ports.capture(true); val work = async { refuses { ports.live(f.p, guard) } }
        started.await(); work.await(); val next = f.ports(25); refuses { next.capture(true) }; next.capture(false)()
        release.complete(Unit); withTimeout(2000) { while (runCatching { f.gate.requireIdle() }.isFailure) delay(5) }
        assertEquals(0, f.heightReads); f.genesisRead = { f.genesis }; next.live(f.p, next.capture(true)); assertEquals(1, f.heightReads); f.gate.close()
    }
    @Test fun `cancelled queued RPC cannot enter or leave its shared fence stuck`() = runBlocking {
        val queue = java.util.ArrayDeque<Runnable>()
        val gate = RealmSalesRpcGate(object : CoroutineDispatcher() {
            override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) { queue.add(block) }
        })
        var entered = false
        try {
            val job = launch(start = CoroutineStart.UNDISPATCHED) { gate.run(30000, {}) { entered = true } }
            assertEquals(1, queue.size); job.cancelAndJoin()
            while (queue.isNotEmpty()) queue.removeFirst().run()
            gate.requireIdle(); assertFalse(entered)
        } finally { gate.close() }
    }
    @Test fun `wallet starts only after durable marker and retains late original bytes before view refusal`() = runBlocking {
        val f = Fixture(); f.seed(); val ports = f.ports(); val guard = ports.capture(true); val prepared = f.wire.prepared()
        refuses { ports.sign(prepared, guard) {} }; assertEquals(0, f.signs)
        f.store.signingAttempt(f.store.read()); f.signed = { f.page = f.page.copy(viewEpoch = 2) }
        refuses { ports.sign(prepared, guard) { f.store.acceptSigned(f.p.idempotencyKey, it.wire) } }
        assertEquals(f.wire.signed.wire, f.store.read().operation?.signed?.wire); assertEquals(1, f.signs); f.gate.close()
    }
    @Test fun `RPC adapter asks for finalized height and exposes no sender`() = runBlocking {
        val methods = mutableListOf<String>(); val f = RealmSalesWalletFixture()
        val rpc = SolanaRealmSalesRpcReads(SolanaRpc { body ->
            methods += body.getValue("method").jsonPrimitive.content
            if (methods.last() == "getBlockHeight") assertEquals("finalized", body.getValue("params").jsonArray.single().jsonObject.getValue("commitment").jsonPrimitive.content)
            buildJsonObject { put("result", if (methods.last() == "getGenesisHash") JsonPrimitive(f.trust.genesisHash) else JsonPrimitive(100)) }
        })
        assertEquals(f.trust.genesisHash, rpc.genesisHash()); assertEquals(100L, rpc.finalizedBlockHeight()); assertEquals(listOf("getGenesisHash", "getBlockHeight"), methods)
    }
}
