package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.PreparedMiningClaim
import gg.pixelkingdomwars.nativeclient.wallet.SolanaRpc
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Read only admitted canonical content. Numeric strings are not catalogue numbers. */
fun miningClaimsPolicy(catalogue: JsonObject?): MiningClaimsProtocolPolicy? = runCatching {
    val constants = requireNotNull(catalogue?.get("constants") as? JsonObject)
    val token = requireNotNull(constants["TOKEN"] as? JsonObject); val quote = requireNotNull(constants["PHASE_E_MINING_CLAIM_QUOTE"] as? JsonObject)
    fun integer(value: JsonElement?): Long { val p = requireNotNull(value as? JsonPrimitive); require(!p.isString); return requireNotNull(p.longOrNull) }
    val decimals = integer(token["decimals"]); val version = integer(quote["version"])
    require(decimals in 0..255 && version in 1..Int.MAX_VALUE)
    MiningClaimsProtocolPolicy(decimals.toInt(), version.toInt(), integer(quote["ttlSec"]),
        (catalogue["mining"] as? JsonObject)?.get("claimFormat")?.let{raw->val f=raw.jsonObject;require(integer(f["version"])==1L);integer(f["computeUnitLimit"]).also{require(it in 1..Int.MAX_VALUE)}.toInt()}).also { it.validate() }
}.getOrNull()

data class MiningClaimsLifecycle(val active: Boolean, val visible: Boolean, val viewEpoch: Long, val actionsAllowed: Boolean,
    val contentReady: Boolean, val contentIdentity: String?, val battleActive: Boolean)
interface MiningClaimsRpcReads { suspend fun genesisHash(): String; suspend fun finalizedBlockHeight(): Long }
class SolanaMiningClaimsRpcReads(private val rpc: SolanaRpc) : MiningClaimsRpcReads {
    override suspend fun genesisHash() = rpc.genesisHash()
    override suspend fun finalizedBlockHeight() = rpc.finalizedBlockHeight()
}

/** AppGraph owns one gate outside session graphs. A timeout requests cancellation
 * but never frees the fence until the actual underlying coroutine has drained. */
class MiningClaimsRpcGate(dispatcher: CoroutineDispatcher = Dispatchers.IO) : AutoCloseable {
    private class Flight { val expired = AtomicBoolean(false) }
    private val lock = Any(); private var pending: Flight? = null; private var closed = false
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    fun requireIdle() = synchronized(lock) { check(!closed && pending == null) { "A mining network check is still pending. Saved claims can be checked." } }
    suspend fun run(timeoutMs: Long, guard: () -> Unit, read: suspend (() -> Unit) -> Unit) {
        require(timeoutMs in 1..30_000); guard()
        val flight = synchronized(lock) { requireIdle(); Flight().also { pending = it } }
        val check = { check(!flight.expired.get()) { "Mining network check expired." }; guard() }
        val work = scope.async(start = CoroutineStart.LAZY) { check(); read(check); check() }
        // A cancelled queued child may never enter its body. Completion covers
        // that case and still waits for a running noncooperative read to drain.
        work.invokeOnCompletion { synchronized(lock) { if (pending === flight) pending = null } }
        work.start()
        try { withTimeout(timeoutMs) { work.await() }; check() }
        catch (error: Exception) {
            flight.expired.set(true); work.cancel()
            if (error is TimeoutCancellationException) throw IOException("Mining network check timed out. Your saved claim is kept.")
            throw error
        }
    }
    override fun close() { synchronized(lock) { closed = true }; scope.cancel() }
}

/** Authenticated DTO adapter only. The wallet callback approves; no RPC sender is exposed. */
class MiningClaimsAppPorts(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: MiningClaimsStore, private val catalogue: () -> JsonObject?,
    private val pins: () -> MiningClaimSigningTrust?, private val lifecycle: () -> MiningClaimsLifecycle,
    private val rpc: MiningClaimsRpcReads, private val rpcGate: MiningClaimsRpcGate,
    private val signer: suspend (PreparedMiningClaim, () -> Unit, (MiningClaimSavedWire) -> Unit) -> Unit,
    private val monotonicMs: () -> Long, private val timeoutMs: Long = 30_000) : MiningClaimsPorts {
    init {
        require(store.identity.wallet == session.wallet && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/'))
        require(timeoutMs in 1..30_000)
    }
    override fun policy() = miningClaimsPolicy(catalogue())
    override fun trust(): MiningClaimSigningTrust? = pins()?.copy()?.also { value ->
        MiningClaimIdentity(value.genesisHash, value.programId, value.configAddress, value.keepMint, value.reserveOwner).validate()
    }
    override fun key() = UUID.randomUUID().toString()
    override fun clockMs() = monotonicMs().also { check(it >= 0) }
    override fun capture(newAction: Boolean): () -> Unit {
        holder.requireCurrent(session)
        val page = lifecycle(); val initialTrust = if (newAction) requireNotNull(trust()) { "Mining claim configuration is unavailable." } else null
        val initialPolicy = if (newAction) requireNotNull(policy()) { "Mining claim content is unavailable." } else null
        if (newAction) rpcGate.requireIdle()
        val guard = {
            holder.requireCurrent(session); val current = lifecycle()
            check(current.active && current.visible && current.viewEpoch == page.viewEpoch) { "The mining claim view changed. Check its saved receipt." }
            if (newAction) {
                check(current.actionsAllowed && current.contentReady && !current.battleActive && !current.contentIdentity.isNullOrBlank()
                    && current.contentIdentity == page.contentIdentity && trust() == initialTrust && policy() == initialPolicy) { "New claim actions changed. Review the saved claim again." }
            }
        }
        guard(); return guard
    }
    private fun original(key: String): MiningClaimsOperation = requireNotNull(store.read().operation).also { require(it.request.idempotencyKey == key) }
    private fun currentPolicy(): MiningClaimsProtocolPolicy = requireNotNull(policy() ?: store.read().let { it.operation?.policy ?: it.archives.lastOrNull()?.policy }) { "Mining claim policy is unavailable." }
    private fun newAction(guard: () -> Unit) { guard(); rpcGate.requireIdle(); requireNotNull(trust()); requireNotNull(policy()) }
    override suspend fun status(guard: () -> Unit): MiningClaimStatusView {
        guard(); val frozen = currentPolicy()
        val value = MiningClaimStatusView.from(api.getMiningClaim("/claims/mining/status", guard), frozen)
        guard(); require(value.wallet == session.wallet); return value
    }
    override suspend fun prepare(request: MiningClaimPrepareRequest, guard: () -> Unit, retain: (MiningClaimPreparationView) -> Unit,
        refusal: (MiningClaimPrepareRefusal) -> Unit): MiningClaimPreparationView {
        newAction(guard); request.validate(); val op = original(request.idempotencyKey); check(op.prepareAttempted)
        fun parse(raw: JsonObject) = MiningClaimPreparationView.from(raw, op.policy).also { require(it.wallet == session.wallet && it.idempotencyKey == request.idempotencyKey) }
        val raw = api.postMiningClaim("/claims/mining/prepare", request.body(), { newAction(guard) }, { retain(parse(it)) }, {
            val value = MiningClaimPrepareRefusal(it.status, requireNotNull(it.code)); value.validate(); refusal(value)
        })
        val value = parse(raw); guard(); return value
    }
    override suspend fun preparation(key: String, guard: () -> Unit, retain: (MiningClaimPreparationEnvelope) -> Unit): MiningClaimPreparationEnvelope {
        guard(); val op = original(key); op.request.validate()
        fun parse(raw: JsonObject) = MiningClaimPreparationEnvelope.from(raw, op.policy).also { require(it.wallet == session.wallet && it.idempotencyKey == key) }
        val raw = api.getMiningClaim("/claims/mining/prepare/by-key/$key", guard) { retain(parse(it)) }
        val value = parse(raw); guard(); return value
    }
    override suspend fun claim(id: String, guard: () -> Unit, retain: (MiningClaimView) -> Unit): MiningClaimView {
        guard(); val p = requireNotNull(store.read().operation?.preparation); require(id == p.claimId)
        fun parse(raw: JsonObject):MiningClaimView {val op=requireNotNull(store.read().operation);if(op.ordered!=null)store.observeOrderedClaim(op.request.idempotencyKey,raw);return MiningClaimView.from(raw).also { require(it.wallet == session.wallet && it.claimId == id) }}
        val raw = api.getMiningClaim("/claims/mining/$id", guard) { retain(parse(it)) }
        val value = parse(raw); guard(); return value
    }
    override suspend fun live(preparation: MiningClaimPreparationView, guard: () -> Unit) {
        newAction(guard); val op = original(preparation.idempotencyKey); preparation.validate(op.policy)
        require(preparation.wallet == session.wallet && op.preparation?.sameOriginal(preparation, op.policy) == true)
        val expected = requireNotNull(trust()); val identity = preparation.identity
        require(expected.copy(orderedLookupTable=null) == MiningClaimSigningTrust(identity.genesisHash, identity.programId, identity.configAddress, identity.keepMint, identity.reserveOwner))
        val heightLimit = preparation.transactions.first().lastValidBlockHeight
        rpcGate.run(timeoutMs, guard) { check ->
            val genesis = rpc.genesisHash(); check(); require(genesis == expected.genesisHash) { "The claim RPC serves a different Solana network." }
            val height = rpc.finalizedBlockHeight(); check(); require(height in 0..9_007_199_254_740_991L) { "Finalized block height is unavailable." }
            check(height <= heightLimit) { "The saved claim blockhash expired. Keep its recovery record." }
        }
    }
    override suspend fun sign(prepared: PreparedMiningClaim, guard: () -> Unit, retain: (MiningClaimSavedWire) -> Unit) {
        newAction(guard); require(prepared.wallet == session.wallet)
        val op = requireNotNull(store.read().operation); if(op.ordered!=null)check(!op.ordered.held&&prepared.ordinal in op.ordered.signingStarted&&op.ordered.signed.none{it.ordinal==prepared.ordinal}) else check(op.signingStarted && op.signed == null)
        // The injected wallet records verified bytes before checking a changed view/session.
        signer(prepared, { newAction(guard) }, retain); guard()
    }
    override suspend fun submit(request: MiningClaimSubmitRequest, guard: () -> Unit): MiningClaimSubmitResponse {
        newAction(guard); request.validate(); val op = requireNotNull(store.read().operation)
        val original=if(op.ordered!=null)op.ordered.signed.singleOrNull{it.wire==request.signedTransaction&&it.ordinal in op.ordered.submitAttempted} else op.signed?.takeIf{op.submitAttempted}
        check(op.preparation?.claimId == request.claimId && original?.wire == request.signedTransaction)
        val response = MiningClaimSubmitResponse.from(api.postMiningClaim("/claims/mining/submit", request.body(), { newAction(guard) }))
        require(response.claimId == request.claimId && response.signature == requireNotNull(original).signature); guard(); return response
    }
    override suspend fun reviewOrdinal(id:String,ordinal:Int,guard:()->Unit):MiningClaimOrdinalReview {
        newAction(guard);val op=requireNotNull(store.read().operation);require(op.preparation?.claimId==id&&op.ordered!=null&&ordinal in 0..1)
        fun parse(raw:JsonObject)=MiningClaimOrdinalReview.from(raw).also{it.bind(requireNotNull(op.preparation),ordinal,op.ordered.parent?.setup)}
        val raw=api.getMiningClaim("/claims/mining/$id/review?ordinal=$ordinal",guard){parse(it)};return parse(raw).also{guard()}
    }
    override suspend fun continuation(id:String,guard:()->Unit,retain:(MiningClaimContinuationEnvelope)->Unit):MiningClaimContinuationEnvelope {
        guard();val op=requireNotNull(store.read().operation);require(op.preparation?.claimId==id&&op.ordered!=null)
        fun parse(raw:JsonObject)=MiningClaimContinuationEnvelope.from(raw,op.policy).also{require(it.wallet==session.wallet&&it.parentClaimId==id)}
        val raw=api.getMiningClaim("/claims/mining/$id/continuation",guard){retain(parse(it))};return parse(raw).also{guard()}
    }
    override suspend fun continueClaim(id:String,key:String,guard:()->Unit,retain:(MiningClaimContinuationEnvelope)->Unit,refusal:(MiningOrderedRefusal)->Unit):MiningClaimContinuationEnvelope {
        newAction(guard);val op=requireNotNull(store.read().operation);require(op.preparation?.claimId==id&&op.ordered?.continuationRequest==key)
        fun parse(raw:JsonObject)=MiningClaimContinuationEnvelope.from(raw,op.policy).also{require(it.wallet==session.wallet&&it.parentClaimId==id)}
        val raw=api.postMiningClaim("/claims/mining/$id/continue",buildJsonObject{put("idempotencyKey",key)},guard,{retain(parse(it))},{failure->refusal(MiningOrderedRefusal(failure.status,requireNotNull(failure.code)).also{it.validate()})});return parse(raw).also{guard()}
    }

}
