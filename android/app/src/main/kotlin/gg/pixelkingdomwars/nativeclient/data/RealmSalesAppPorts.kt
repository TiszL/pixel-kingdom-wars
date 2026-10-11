package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Every economic field comes from admitted canonical content; no bootstrap or quote fallback. */
fun realmSalesPolicy(catalogue: JsonObject?): RealmSalesSavedPolicy? = runCatching {
    val c = requireNotNull(catalogue?.get("constants") as? JsonObject)
    fun obj(parent: JsonObject, name: String) = requireNotNull(parent[name] as? JsonObject)
    fun number(parent: JsonObject, name: String): Long {
        val p = requireNotNull(parent[name] as? JsonPrimitive); require(!p.isString)
        return requireNotNull(p.longOrNull).also { require(it in 0..9_007_199_254_740_991L) }
    }
    fun int(parent: JsonObject, name: String) = number(parent, name).also { require(it <= Int.MAX_VALUE) }.toInt()
    val policy = obj(c, "PHASE_E_POLICY"); val island = obj(policy, "seekerIsland"); val sale = obj(c, "PHASE_E_SEEKER_SALE")
    RealmSalesSavedPolicy(RealmSalesProtocolPolicy(int(sale, "version"), number(sale, "quoteTtlSec"),
        number(obj(c, "PHASE_E_MINING_PUBLICATION"), "daySec"), int(island, "totalSpots"), int(island, "realmCount"),
        int(island, "paidContractsPerSpotDayMax"), number(island, "permitDurationSec"), number(island, "permitPriceLamports"),
        int(policy, "basisPoints"), int(island, "contractSellerBps"), int(island, "contractDevBps")),
        int(island, "kingSpots"), int(obj(c, "PHASE_E_SEEKER_AUCTION"), "regularRealmCount")).also { it.signing() }
}.getOrNull()

data class RealmSalesLifecycle(val active: Boolean, val visible: Boolean, val viewEpoch: Long, val actionsAllowed: Boolean,
    val contentReady: Boolean, val contentIdentity: String?, val battleActive: Boolean)
interface RealmSalesRpcReads { suspend fun genesisHash(): String; suspend fun finalizedBlockHeight(): Long }
class SolanaRealmSalesRpcReads(private val rpc: SolanaRpc) : RealmSalesRpcReads {
    override suspend fun genesisHash() = rpc.genesisHash()
    override suspend fun finalizedBlockHeight() = rpc.finalizedBlockHeight()
}

/** Owned outside session graphs. Expiry requests cancellation but cannot release
 * the fence while a noncooperative underlying request is still running. */
class RealmSalesRpcGate(dispatcher: CoroutineDispatcher = Dispatchers.IO) : AutoCloseable {
    private class Flight { val expired = AtomicBoolean(false) }
    private val lock = Any(); private var pending: Flight? = null; private var closed = false
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    fun requireIdle() = synchronized(lock) { check(!closed && pending == null) { "A purchase network check is still pending. Saved purchases can be checked." } }
    suspend fun run(timeoutMs: Long, guard: () -> Unit, read: suspend (() -> Unit) -> Unit) {
        require(timeoutMs in 1..30_000); guard()
        val flight = synchronized(lock) { requireIdle(); Flight().also { pending = it } }
        val check = { check(!flight.expired.get()) { "Purchase network check expired." }; guard() }
        val work = scope.async(start = CoroutineStart.LAZY) { check(); read(check); check() }
        work.invokeOnCompletion { synchronized(lock) { if (pending === flight) pending = null } }
        work.start()
        try { withTimeout(timeoutMs) { work.await() }; check() }
        catch (error: Exception) {
            flight.expired.set(true); work.cancel()
            if (error is TimeoutCancellationException) throw IOException("Purchase network check timed out. Your saved purchase is kept.")
            throw error
        }
    }
    override fun close() { synchronized(lock) { closed = true }; scope.cancel() }
}

/** Authenticated transport and sign-only wallet capability. Independent pins are
 * supplied by AppGraph, never inferred from HTTP responses or historical records. */
class RealmSalesAppPorts(private val session: AccountSession, private val holder: AccountSessionHolder,
    api: ApiClient, private val store: RealmSalesStore, private val catalogue: () -> JsonObject?,
    private val pins: () -> RealmSaleSigningTrust?, private val lifecycle: () -> RealmSalesLifecycle,
    private val rpc: RealmSalesRpcReads, private val rpcGate: RealmSalesRpcGate,
    private val signer: suspend (PreparedRealmSale, () -> Unit, suspend (SignedRealmSale) -> Unit) -> Unit,
    private val walletReady: suspend (() -> Unit) -> Unit,
    private val monotonicMs: () -> Long, private val timeoutMs: Long = 30_000) : RealmSalesPorts {
    init {
        require(store.identity.wallet == session.wallet && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/'))
        require(timeoutMs in 1..30_000)
    }
    override val transport = RealmSalesTransport(RealmSalesTransportBinding(store.identity, session, holder, api))
    override fun policy() = realmSalesPolicy(catalogue())
    override fun trust() = pins()?.copy()
    override fun key() = UUID.randomUUID().toString()
    override fun clockMs() = monotonicMs().also { check(it >= 0) }
    override fun capture(newAction: Boolean): () -> Unit {
        holder.requireCurrent(session)
        val page = lifecycle()
        val initialTrust = if (newAction) requireNotNull(trust()) { "Purchase configuration is unavailable." } else null
        val initialPolicy = if (newAction) requireNotNull(policy()) { "Purchase content is unavailable." } else null
        if (newAction) rpcGate.requireIdle()
        val guard = {
            holder.requireCurrent(session); val current = lifecycle()
            check(current.active && current.visible && current.viewEpoch == page.viewEpoch) { "The purchase view changed. Check its saved outcome." }
            if (newAction) check(current.actionsAllowed && current.contentReady && !current.battleActive &&
                !current.contentIdentity.isNullOrBlank() && current.contentIdentity == page.contentIdentity &&
                trust() == initialTrust && policy() == initialPolicy) { "Purchase admission changed. Review the saved purchase again." }
        }
        guard(); return guard
    }
    private fun newAction(guard: () -> Unit) { guard(); rpcGate.requireIdle(); requireNotNull(trust()); requireNotNull(policy()) }
    override suspend fun live(preparation: RealmSalePreparation, guard: () -> Unit) {
        newAction(guard); val op = requireNotNull(store.read().operation); guard()
        check(op.preparation == preparation && op.policy == policy()); require(preparation.wallet == session.wallet)
        preparation.validate(op.policy.protocol)
        val expected = requireNotNull(trust()); val source = preparation.source
        require(expected == RealmSaleSigningTrust(source.genesisHash, source.programId, preparation.terms.developer,
            source.programDataSha256, source.reviewedDeploymentSlot, source.revision))
        val limit = preparation.quote.lastValidBlockHeight
        rpcGate.run(timeoutMs, guard) { check ->
            val genesis = rpc.genesisHash(); check(); require(genesis == expected.genesisHash) { "The purchase RPC serves a different Solana network." }
            val height = rpc.finalizedBlockHeight(); check(); require(height in 0..9_007_199_254_740_991L) { "Finalized block height is unavailable." }
            check(height <= limit) { "Original purchase blockhash expired. Keep its recovery record." }
        }
    }
    override suspend fun readyToSign(guard: () -> Unit) {
        newAction(guard); walletReady { newAction(guard) }; newAction(guard)
    }
    override suspend fun sign(prepared: PreparedRealmSale, guard: () -> Unit, retain: suspend (SignedRealmSale) -> Unit) {
        newAction(guard); require(prepared.wallet == session.wallet)
        val op = requireNotNull(store.read().operation); guard()
        check(op.signingStarted && op.signed == null && op.policy == policy())
        val canonical = RealmSaleTransaction.prepare(requireNotNull(op.preparation), op.policy.signing(), requireNotNull(trust()))
        require(canonical.unsignedTransaction().contentEquals(prepared.unsignedTransaction()))
        newAction(guard)
        signer(prepared, { newAction(guard) }, retain); guard()
    }
}
