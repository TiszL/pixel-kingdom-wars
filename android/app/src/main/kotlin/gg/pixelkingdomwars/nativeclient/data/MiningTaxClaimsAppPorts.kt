package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.time.Duration
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

data class MiningTaxClaimsAppPolicy(val daySec: Long, val totalSpots: Int, val tokenDecimals: Int) {
    fun signing() = MiningTaxClaimsSigningPolicy(daySec).also { it.validate(); require(totalSpots in 1..256 && tokenDecimals in 0..255) }
}
/** Current admission/display values come only from admitted canonical content. */
fun miningTaxClaimsPolicy(catalogue: JsonObject?): MiningTaxClaimsAppPolicy? = runCatching {
    val c = requireNotNull(catalogue?.get("constants") as? JsonObject)
    fun obj(parent: JsonObject, key: String) = requireNotNull(parent[key] as? JsonObject)
    fun number(parent: JsonObject, key: String): Long {
        val value = requireNotNull(parent[key] as? JsonPrimitive); require(!value.isString)
        return requireNotNull(value.longOrNull).also { require(it in 0..9_007_199_254_740_991L) }
    }
    val spots = number(obj(obj(c, "PHASE_E_POLICY"), "seekerIsland"), "totalSpots")
    val decimals = number(obj(c, "TOKEN"), "decimals"); require(spots <= Int.MAX_VALUE && decimals <= Int.MAX_VALUE)
    MiningTaxClaimsAppPolicy(number(obj(c, "PHASE_E_MINING_PUBLICATION"), "daySec"), spots.toInt(), decimals.toInt()).also { it.signing() }
}.getOrNull()
data class MiningTaxClaimsLifecycle(val active: Boolean, val visible: Boolean, val viewEpoch: Long, val actionsAllowed: Boolean,
    val contentReady: Boolean, val contentIdentity: String?, val battleActive: Boolean)

/** Requires the existing authentication cookie owner, never a second credential store.
 * Production has no default deployment pins. No wallet sender or activation is exposed. */
class MiningTaxClaimsAppPorts(private val session: AccountSession, private val holder: AccountSessionHolder,
    apiOrigin: String, private val cluster: SolanaCluster, private val httpPort: MiningTaxClaimsHttpPort,
    private val store: MiningTaxClaimsStore, private val catalogue: () -> JsonObject?, private val miningEnabled: () -> Boolean,
    private val lifecycle: () -> MiningTaxClaimsLifecycle, override val wallet: MiningTaxClaimsWallet,
    private val rpc: MiningClaimsRpcReads, private val rpcGate: MiningClaimsRpcGate, private val monotonicMs: () -> Long,
    private val independentPins: () -> MiningTaxClaimsSigningTrust? = { null }, private val timeoutMs: Long = 30_000) : MiningTaxClaimsPorts {
    init {
        val origin = apiOrigin.toHttpUrl(); require(origin.isHttps && origin.encodedPath == "/" && origin.query == null && origin.fragment == null && origin.username.isEmpty() && origin.password.isEmpty())
        require(origin.toString().trimEnd('/') == apiOrigin && store.identity.origin == apiOrigin && session.origin.toHttpUrl().toString().trimEnd('/') == apiOrigin)
        require(store.identity.wallet == session.wallet && store.identity.cluster == cluster.id && timeoutMs in 1..30_000)
        holder.requireCurrent(session); httpPort.requireCurrent(store.identity, session.token)
    }
    override val transport = MiningTaxClaimsTransport(httpPort, miningEnabled)
    fun appPolicy() = miningTaxClaimsPolicy(catalogue())
    override fun policy() = appPolicy()?.signing()
    override fun totalSpots() = requireNotNull(appPolicy()).totalSpots
    override fun trust() = independentPins()?.copy()?.also {
        require(it.genesisHash == cluster.genesisHash && it.reviewedDeploymentSlot in 0..9_007_199_254_740_991L && it.reviewedProgramDataSha256.matches(Regex("[0-9a-f]{64}")))
    }
    override fun key() = UUID.randomUUID().toString()
    override fun clockMs() = monotonicMs().also { check(it >= 0) }
    override fun capture(newAction: Boolean): () -> Unit {
        holder.requireCurrent(session); httpPort.requireCurrent(store.identity, session.token)
        val page = lifecycle(); val pins = if (newAction) requireNotNull(trust()) { "KEEP tax claim configuration is unavailable" } else null
        val rules = if (newAction) requireNotNull(appPolicy()) { "KEEP tax claim content is unavailable" } else null
        if (newAction) rpcGate.requireIdle()
        val guard = {
            holder.requireCurrent(session); httpPort.requireCurrent(store.identity, session.token); val current = lifecycle()
            check(current.active && current.visible && current.viewEpoch == page.viewEpoch) { "The tax claim view changed; check its saved outcome" }
            if (newAction) check(miningEnabled() && current.actionsAllowed && current.contentReady && !current.battleActive &&
                !current.contentIdentity.isNullOrBlank() && current.contentIdentity == page.contentIdentity && trust() == pins && appPolicy() == rules) {
                "New tax claim actions changed; review the saved request again"
            }
        }
        guard(); return guard
    }
    override suspend fun live(preparation: MiningTaxClaimsPreparation, ordinal: Int, guard: () -> Unit) {
        guard(); rpcGate.requireIdle(); preparation.validate()
        val p = MiningTaxClaimsPreparation.from(Json.encodeToJsonElement(MiningTaxClaimsPreparation.serializer(), preparation).jsonObject)
        val currentAdmission = capture(true); currentAdmission()
        val journal = store.read(); guard(); currentAdmission(); val op = requireNotNull(journal.operation)
        require(op.preparation == p && p.wallet == session.wallet && ordinal in p.transactions.indices)
        val expected = requireNotNull(trust()); val rules = requireNotNull(policy())
        require(op.trust == MiningTaxClaimsSavedTrust.from(expected) && op.daySec == rules.daySec)
        val unheld = store.effectGuard(journal, ordinal); guard(); currentAdmission(); unheld()
        val started = clockMs(); val result = transport.review(p, ordinal) { guard(); currentAdmission(); unheld() }
        guard(); currentAdmission(); unheld(); val review = requireNotNull(result.review) { "Current tax review is unavailable" }
        if (ordinal == 1) {
            val setup = requireNotNull(op.setup?.settlement?.receipt)
            require(review.paidFeeLamports == setup.feeLamports && review.paidRentLamports == setup.rentLamports) { "Current tax review differs from paid setup costs" }
        }
        val budget = Duration.between(Instant.parse(result.serverNow), Instant.parse(p.expiresAt)).toMillis()
        val check = {
            guard(); currentAdmission(); unheld()
            val elapsed = Math.subtractExact(clockMs(), started); check(elapsed >= 0 && elapsed < budget) { "Original tax consent expired; keep its saved request" }
            check(trust() == expected && policy() == rules)
        }
        check()
        rpcGate.run(timeoutMs, check) { live ->
            val genesis = rpc.genesisHash(); live(); require(genesis == expected.genesisHash) { "The tax claim RPC serves a different network" }
            val height = rpc.finalizedBlockHeight(); live(); require(height in maxOf(p.blockHeight, review.source.blockHeight)..p.lastValidBlockHeight) { "The original tax blockhash is unavailable, regressed or expired" }
        }
        check()
    }
}
