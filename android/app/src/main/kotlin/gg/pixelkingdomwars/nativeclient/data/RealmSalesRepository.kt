package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.realmsales.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.math.BigInteger
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** Admission/lifecycle and live network reads belong to the application adapter.
 * Policy is canonical content; trust is independently reviewed application pins,
 * never values copied from preparation/API bootstrap. Wallet exposes signing only
 * and awaits retain even when its originating view/session has become obsolete. */
interface RealmSalesPorts {
    val transport: RealmSalesTransport
    fun capture(newAction: Boolean): () -> Unit
    fun policy(): RealmSalesSavedPolicy?
    fun trust(): RealmSaleSigningTrust?
    fun key(): String
    fun clockMs(): Long
    suspend fun live(preparation: RealmSalePreparation, guard: () -> Unit)
    suspend fun readyToSign(guard: () -> Unit)
    suspend fun sign(prepared: PreparedRealmSale, guard: () -> Unit, retain: suspend (SignedRealmSale) -> Unit)
}
data class RealmSalesReview(val preparation: RealmSalePreparation, val current: RealmSaleReview)
data class RealmSalesState(val loaded: Boolean = false, val busy: Boolean = false, val journal: RealmSalesJournal? = null,
    val review: RealmSalesReview? = null, val error: String? = null)

/** Explicit prepare/sign/submit only; open and recovery are GET-only. Unknown
 * wallet or HTTP outcomes retain the original key and irreversible attempt marker.
 * Verified owner-attested receipts can archive; no chain-finality claim is added. */
class RealmSalesRepository(private val store: RealmSalesStore, private val ports: RealmSalesPorts) {
    private val mutable = MutableStateFlow(RealmSalesState()); val state = mutable.asStateFlow()
    private data class Review(val value: RealmSalesReview, val started: Long, val guard: () -> Unit)
    private var reviewed: Review? = null
    @Volatile private var epoch = 0L
    init { require(ports.transport.identity == store.identity) }
    fun dismiss() { epoch++; reviewed = null; mutable.value = mutable.value.copy(review = null) }
    suspend fun awaitIdle() { store.requests.withLock { } }
    private fun operation() = requireNotNull(mutable.value.journal?.operation) { "Recover the original purchase first." }
    private fun unheld() { check(mutable.value.journal?.settlementHeld != true) { "Verify the saved settlement before another action." } }
    private suspend fun reload(guard: () -> Unit) {
        guard(); val journal = store.read(); guard(); mutable.value = mutable.value.copy(loaded = true, journal = journal)
    }
    private suspend fun action(newAction: Boolean, block: suspend (() -> Unit) -> Unit) {
        val captured = ports.capture(newAction); val originalEpoch = epoch
        val guard = { captured(); check(epoch == originalEpoch) { "The purchase view changed. Recover its saved outcome." } }
        guard(); check(store.requests.tryLock()) { "Another request is handling this original purchase." }
        try {
            mutable.value = mutable.value.copy(busy = true, error = null); reload(guard); block(guard)
        } catch (error: Exception) {
            reviewed = null
            if (runCatching { guard() }.isSuccess) mutable.value = mutable.value.copy(review = null, error = error.message ?: "Recover the saved purchase.")
            throw error
        } finally {
            store.requests.unlock()
            if (runCatching { captured() }.isSuccess) mutable.value = mutable.value.copy(busy = false, review = if (epoch == originalEpoch) mutable.value.review else null)
        }
    }
    private suspend fun retainPreparation(request: RealmSalePrepareRequest, value: RealmSalePreparationEnvelope) {
        require(value.wallet == store.identity.wallet && value.idempotencyKey == request.idempotencyKey)
        val preparation = value.preparation
        if (preparation != null) store.acceptPreparation(request.idempotencyKey, preparation)
        else {
            val active = store.read().operation
            check(active?.request == request && active.preparation == null) { "Original preparation is temporarily unavailable." }
        }
    }
    private suspend fun retainSaved(request: RealmSalePrepareRequest, input: JsonObject, submitted: Boolean) {
        val id = request.idempotencyKey; ports.transport.attributeOwner(input, id)
        val positive = input["settlement"]?.let { it != JsonNull } == true
        val prepared = input["preparation"]?.let { it != JsonNull } == true || input["wire"]?.let { it != JsonNull } == true
        if (positive) store.observeSettlementKey(id)
        if (prepared) store.observePreparationKey(id)
        val owned = runCatching { realmSaleEvidenceCopy(input).jsonObject }
        withContext(NonCancellable) {
            if (positive) store.observeSettlement(id)
            if (prepared) store.observePreparation(id)
            val raw = owned.getOrThrow()
            // Original custody is independently checked before any adjacent preparation,
            // receipt or envelope shape can reject an already-owned signed response.
            raw["wire"]?.takeUnless { it == JsonNull }?.let { store.acceptSavedWire(id, it) }
            ports.transport.attribute(raw, id, submitted)
            val op = requireNotNull(store.read().operation); check(op.request == request)
            if (!submitted) retainPreparation(request, RealmSalePreparationEnvelope.from(buildJsonObject {
                put("wallet", store.identity.wallet); put("idempotencyKey", id); put("preparation", raw.getValue("preparation"))
            }, op.policy.protocol))
            if (positive) store.acceptSettlement(id, raw.getValue("wire"), raw.getValue("settlement"))
            else if (submitted) check(raw.getValue("wire") != JsonNull)
        }
    }
    private suspend fun recoverFailure(request: RealmSalePrepareRequest, guard: () -> Unit): RealmSaleFailure? {
        var result: RealmSaleFailure? = null
        ports.transport.failures(request.idempotencyKey, guard) { input ->
            ports.transport.attributeOwner(input, request.idempotencyKey)
            val positive = input["failure"]?.let { it != JsonNull } == true
            if (positive) store.observeFailureKey(request.idempotencyKey)
            val owned = runCatching { realmSaleEvidenceCopy(input).jsonObject }
            try { withContext(NonCancellable) {
                if (positive) store.observeFailure(request.idempotencyKey)
                val op = requireNotNull(store.read().operation); check(op.request == request)
                val raw = owned.getOrThrow()
                raw["wire"]?.takeUnless { it == JsonNull }?.let { store.acceptSavedWire(request.idempotencyKey, it) }
                val value = RealmSaleFailureEnvelope.from(raw, op.policy.protocol)
                val failure = value.failure
                if (failure != null) {
                    val metadata = requireNotNull(op.wireMetadata ?: op.settlement?.wire) { "Original signed custody must be recovered first" }
                    store.acceptFailure(request.idempotencyKey, Json.encodeToJsonElement(RealmSaleSignedWire.serializer(), metadata),
                        Json.encodeToJsonElement(RealmSaleFailure.serializer(), failure))
                }
                result = value.failure
            } } catch (error: Exception) {
                if (positive) {
                    store.observeUnknownKey(request.idempotencyKey)
                    try { withContext(NonCancellable) { store.read() } } catch (storage: Exception) { if (storage !== error) error.addSuppressed(storage) }
                }
                throw error
            }
        }
        return result
    }
    private suspend fun recover(guard: () -> Unit): Boolean {
        val op = mutable.value.journal?.operation ?: return false
        if (op.settlement != null && !op.failureObserved) return false
        var preparationAbsent = false; var savedAbsent = false
        ports.transport.preparation(op.request, op.policy.protocol, false, guard, observe = { store.observePreparation(op.request.idempotencyKey) }) {
            retainPreparation(op.request, it); preparationAbsent = it.preparation == null
        }; reload(guard)
        ports.transport.saved(op.request.idempotencyKey, guard) {
            retainSaved(op.request, it, false)
            savedAbsent = it.getValue("preparation") == JsonNull && it.getValue("wire") == JsonNull && it.getValue("settlement") == JsonNull
        }; reload(guard)
        if (op.signingStarted || op.signed != null || op.failureObserved) { recoverFailure(op.request, guard); reload(guard) }
        return preparationAbsent && savedAbsent
    }
    private fun fresh(review: Review) {
        val elapsed = Math.subtractExact(ports.clockMs(), review.started); require(elapsed >= 0)
        val left = BigInteger(review.value.preparation.terms.validUntil) - BigInteger(review.value.current.unixTimestamp)
        check(left.signum() >= 0 && elapsed.toBigInteger() <= left * BigInteger.valueOf(1000)) { "Original consent expired. Keep its recovery record." }
    }
    private suspend fun current(p: RealmSalePreparation, guard: () -> Unit): Review {
        val started = ports.clockMs(); require(started >= 0)
        val value = ports.transport.review(p, operation().policy.protocol, guard)
        guard(); return Review(RealmSalesReview(p, value), started, guard).also { fresh(it) }
    }
    suspend fun open() = action(false) { guard -> reviewed = null; mutable.value = mutable.value.copy(review = null); recover(guard) }
    suspend fun begin(spot: Long, realm: Long) = action(true) { guard ->
        unheld(); check(mutable.value.journal?.operation == null)
        val policy = requireNotNull(ports.policy()); policy.signing(); requireNotNull(ports.trust())
        val request = RealmSalePrepareRequest(ports.key(), spot, realm); request.validate(policy.protocol)
        guard(); store.begin(requireNotNull(mutable.value.journal), request, policy); reload(guard)
        guard(); store.prepareAttempt(requireNotNull(mutable.value.journal)); reload(guard)
        val effects = store.effectGuard(requireNotNull(mutable.value.journal)); var responseOwned = false
        val effectGuard = { guard(); if (!responseOwned) effects() }
        ports.transport.preparation(request, policy.protocol, true, effectGuard,
            refusal = {
                responseOwned = true
                store.acceptPrepareRefusal(request.idempotencyKey, it)
                // Retain first; only a current view may publish the new refusal.
                runCatching { reload(guard) }
            },
            observe = { responseOwned = true; store.observePreparation(request.idempotencyKey) }) {
            responseOwned = true; retainPreparation(request, it)
        }; reload(guard)
    }
    suspend fun review() = action(true) { guard ->
        reviewed = null; mutable.value = mutable.value.copy(review = null); recover(guard); unheld()
        val op = operation(); check(op.prepareRefusal == null && !op.signingStarted && op.signed == null)
        val value = current(requireNotNull(op.preparation), guard); reviewed = value; mutable.value = mutable.value.copy(review = value.value)
    }
    suspend fun sign() = action(true) { guard ->
        val review = requireNotNull(reviewed) { "Review original SOL limits before wallet approval." }; review.guard(); fresh(review)
        recover(guard); unheld(); val op = operation(); check(op.prepareRefusal == null && !op.signingStarted && op.signed == null && op.preparation == review.value.preparation)
        current(requireNotNull(op.preparation), guard); review.guard(); fresh(review)
        val trust = requireNotNull(ports.trust()); check(ports.policy() == op.policy)
        val prepared = RealmSaleTransaction.prepare(op.preparation, op.policy.signing(), trust)
        ports.live(op.preparation, guard); guard(); review.guard(); fresh(review); check(ports.trust() == trust && ports.policy() == op.policy)
        ports.readyToSign(guard); guard(); review.guard(); fresh(review)
        store.signingAttempt(requireNotNull(mutable.value.journal)); reload(guard); review.guard(); fresh(review)
        val effects = store.effectGuard(requireNotNull(mutable.value.journal))
        val effectGuard = { guard(); review.guard(); fresh(review); check(ports.trust() == trust && ports.policy() == op.policy); effects() }
        ports.sign(prepared, effectGuard) { value ->
            val verified = prepared.verifySignedBase64(value.wire); require(verified.signature == value.signature)
            store.acceptSigned(op.request.idempotencyKey, verified.wire)
        }
        guard(); review.guard(); check(store.read().operation?.signed != null)
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun submit() = action(true) { guard ->
        recover(guard); unheld(); val op = operation(); check(op.prepareRefusal == null && !op.submitAttempted)
        val p = requireNotNull(op.preparation); val signed = requireNotNull(op.signed); val current = current(p, guard)
        val trust = requireNotNull(ports.trust()); check(ports.policy() == op.policy)
        val verified = RealmSaleTransaction.prepare(p, op.policy.signing(), trust).verifySignedBase64(signed.wire); require(verified.signature == signed.signature)
        ports.live(p, guard); guard(); fresh(current); check(ports.trust() == trust && ports.policy() == op.policy)
        store.submitAttempt(requireNotNull(mutable.value.journal)); reload(guard); fresh(current)
        val effects = store.effectGuard(requireNotNull(mutable.value.journal)); var responseOwned = false
        val effectGuard = { guard(); fresh(current); check(ports.trust() == trust && ports.policy() == op.policy); if (!responseOwned) effects() }
        ports.transport.submit(op.request.idempotencyKey, signed.wire, effectGuard) {
            responseOwned = true; retainSaved(op.request, it, true)
        }; reload(guard)
    }
    suspend fun archive() = action(false) { guard ->
        val expected = requireNotNull(mutable.value.journal); check(expected.operation?.settlement != null)
        guard(); store.archive(expected); reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun archiveFailed() = action(false) { guard ->
        val expected = requireNotNull(mutable.value.journal); val op = requireNotNull(expected.operation)
        check(op.signingStarted && op.signed != null)
        ports.transport.saved(op.request.idempotencyKey, guard) { retainSaved(op.request, it, false) }
        val fresh = requireNotNull(recoverFailure(op.request, guard)) { "Fresh failed-execution evidence is unavailable" }
        guard(); store.archiveFailed(expected, fresh, guard)
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun archiveRefusal() = action(false) { guard ->
        unheld(); check(operation().prepareRefusal != null)
        check(recover(guard)) { "Both original records must be explicitly absent before archiving this refusal." }; unheld()
        guard(); store.confirmRefusalAbsent(requireNotNull(mutable.value.journal)); reload(guard)
        guard(); store.archive(requireNotNull(mutable.value.journal))
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    /** Dead-end audit 2026-10-06 (shape A). The single active slot blocks every new purchase. A prepare whose reply
     * was lost, with no refusal, is archived only when this same action's two original by-key GETs (preparation
     * and saved evidence) both answered absence for exactly its key. Any shown preparation is retained instead. */
    suspend fun archiveUnanswered() = action(false) { guard ->
        unheld(); val op = operation()
        check(op.prepareAttempted && op.preparation == null && op.prepareRefusal == null && !op.signingStarted && op.signed == null) { "Only an unanswered quote request can be closed." }
        check(recover(guard)) { "Both original records must be explicitly absent before closing this request." }; unheld()
        guard(); store.confirmAttemptAbsent(requireNotNull(mutable.value.journal)); reload(guard)
        guard(); store.archive(requireNotNull(mutable.value.journal))
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    /** Read one bounded verified history record (paid receipt or unsigned refusal). This cannot
     * change the active request, erase evidence, or authorize another purchase. */
    suspend fun archived(id: String): RealmSalesArchive? {
        var result: RealmSalesArchive? = null
        action(false) { guard -> result = store.archived(id); guard() }
        return result
    }
}

// Technical response bounds, independent from costs or gameplay tuning.
private fun realmSaleEvidenceCopy(raw: JsonElement): JsonElement {
    var nodes = 0
    fun copy(value: JsonElement, depth: Int): JsonElement {
        require(++nodes <= 768 && depth <= 12)
        return when (value) {
            is JsonObject -> { require(value.size <= 40); JsonObject(value.entries.associate { (k, v) -> require(k.length <= 64); k to copy(v, depth + 1) }) }
            is JsonArray -> { require(value.size <= 6); JsonArray(value.map { copy(it, depth + 1) }) }
            is JsonPrimitive -> value.also { require(it.content.length <= 2464) }
        }
    }
    return copy(raw, 0)
}
