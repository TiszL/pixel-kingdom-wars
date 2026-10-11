package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.time.Duration
import java.time.Instant
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** The app supplies current admission and independent pins; history keeps its saved
 * day unit. live must freshly revalidate the selected original transaction, and
 * capture's guard must refuse a changed session/admission after every suspension.
 * The monotonic clock is elapsed time, never a wall-clock interpretation of history. */
interface MiningTaxClaimsPorts {
    val transport: MiningTaxClaimsTransport
    val wallet: MiningTaxClaimsWallet
    fun capture(newAction: Boolean): () -> Unit
    fun trust(): MiningTaxClaimsSigningTrust?
    fun policy(): MiningTaxClaimsSigningPolicy?
    fun totalSpots(): Int
    fun key(): String
    fun clockMs(): Long
    suspend fun live(preparation: MiningTaxClaimsPreparation, ordinal: Int, guard: () -> Unit)
}
data class MiningTaxClaimsReview(val preparation: MiningTaxClaimsPreparation, val current: MiningTaxClaimsReviewResponse)
data class MiningTaxClaimsState(val loaded: Boolean = false, val busy: Boolean = false, val journal: MiningTaxClaimsJournal? = null,
    val review: MiningTaxClaimsReview? = null, val error: String? = null)

/** Explicit effects only. HTTP acknowledgements never settle a payment: a complete
 * original GET, local signed prefix and the store's owner-attestation binder do.
 * Unknown results preserve attempt markers. No automatic replay, re-sign or clear. */
class MiningTaxClaimsRepository(private val store: MiningTaxClaimsStore, private val ports: MiningTaxClaimsPorts) {
    private val mutable = MutableStateFlow(MiningTaxClaimsState()); val state = mutable.asStateFlow()
    private data class Review(val value: MiningTaxClaimsReview, val started: Long, val budget: Long, val guard: () -> Unit)
    private var reviewed: Review? = null
    private val epoch = AtomicLong(); private val closed = AtomicBoolean()
    init { require(store.identity == ports.transport.identity) }
    fun dismiss() { epoch.incrementAndGet(); reviewed = null; mutable.value = mutable.value.copy(review = null) }
    suspend fun awaitIdle() { store.requests.withLock { } }
    suspend fun close() {
        closed.set(true); dismiss()
        withContext(NonCancellable) { awaitIdle() }
        mutable.value = MiningTaxClaimsState()
    }
    private fun operation() = requireNotNull(mutable.value.journal?.operation) { "Recover the original tax claim first" }
    private suspend fun reload(guard: () -> Unit) {
        guard(); val journal = store.read(); guard(); mutable.value = mutable.value.copy(loaded = true, journal = journal)
    }
    private suspend fun action(newAction: Boolean, block: suspend (() -> Unit) -> Unit) {
        val captured = ports.capture(newAction); val originalEpoch = epoch.get(); val context = currentCoroutineContext()
        val guard = { context.ensureActive(); captured(); check(!closed.get() && epoch.get() == originalEpoch) { "The tax claim view changed; recover its saved outcome" } }
        guard(); check(store.requests.tryLock()) { "Another request is handling this original tax claim" }
        try {
            mutable.value = mutable.value.copy(busy = true, error = null); reload(guard); block(guard)
        } catch (error: Exception) {
            reviewed = null
            if (runCatching { guard() }.isSuccess) mutable.value = mutable.value.copy(review = null, error = error.message ?: "Recover the original tax claim")
            throw error
        } finally {
            store.requests.unlock()
            if (!closed.get() && runCatching { captured() }.isSuccess) mutable.value = mutable.value.copy(busy = false,
                review = if (epoch.get() == originalEpoch) mutable.value.review else null)
        }
    }
    private fun pins(op: MiningTaxClaimsOperation): Pair<MiningTaxClaimsSigningTrust, MiningTaxClaimsSigningPolicy> {
        val trust = requireNotNull(ports.trust()).copy(); val policy = requireNotNull(ports.policy()).copy().also { it.validate() }
        require(MiningTaxClaimsSavedTrust.from(trust) == op.trust && policy.daySec == op.daySec) { "The application tax trust or historical day policy changed" }
        return trust to policy
    }
    private fun selectable(op: MiningTaxClaimsOperation, ordinal: Int) {
        val p = requireNotNull(op.preparation); require(ordinal in p.transactions.indices)
        check(op.settlement == null && op.failure == null && !op.failureObserved && op.continuation == null && !op.continuationObserved && !op.unattributedObserved && !store.settlementHeld(op.request.idempotencyKey, ordinal)) { "Recover the observed tax outcome first" }
        check(ordinal == 0 || op.setup != null) { "The claim requires a verified original setup receipt" }
    }
    private suspend fun retainPreparation(request: MiningTaxClaimsPrepareRequest, envelope: MiningTaxClaimsPreparationEnvelope) {
        require(envelope.wallet == store.identity.wallet && envelope.idempotencyKey == request.idempotencyKey)
        envelope.preparation?.let { store.acceptPreparation(request.idempotencyKey, it) }
    }
    private suspend fun retainWire(request: MiningTaxClaimsPrepareRequest, wire: MiningTaxClaimsSignedWire) = withContext(NonCancellable) {
        val op = requireNotNull(store.read().operation); check(op.request == request)
        val p = requireNotNull(op.preparation)
        require(wire.wallet == store.identity.wallet && wire.idempotencyKey == request.idempotencyKey && wire.claimId == p.claimId)
        val bytes = wire.signedTransactionHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val verified = MiningTaxClaimsCrypto.verifySigned(p, Base64.getEncoder().encodeToString(bytes), MiningTaxClaimsSigningPolicy(op.daySec), wire.ordinal.toInt())
        require(verified.signature == wire.signature && verified.messageSha256 == wire.messageSha256 && verified.wireSha256 == wire.wireSha256)
        if (op.transactions.none { it.ordinal == verified.ordinal && it.signingStarted }) {
            store.observeSettlement(request.idempotencyKey, verified.ordinal)
            error("Server custody has no saved local signing consent")
        }
        store.acceptSigned(request.idempotencyKey, verified.ordinal, verified.wire); Unit
    }
    /** The synchronous callback latches before fallible parsing/storage. The finally
     * persists every observed ordinal even if the owned reply fails or is cancelled. */
    private suspend fun observed(key: String, block: suspend ((Int?) -> Unit) -> Unit) {
        val pending = linkedSetOf<Int?>()
        val observe: (Int?) -> Unit = { ordinal -> store.observeSettlementKey(key, ordinal); synchronized(pending) { pending.add(ordinal) }; Unit }
        try { block(observe) }
        finally { withContext(NonCancellable) { for (ordinal in synchronized(pending) { pending.toList() }) store.observeSettlement(key, ordinal) } }
    }
    private suspend fun recoverOriginal(guard: () -> Unit): Boolean {
        val op = mutable.value.journal?.operation ?: return false
        if (op.settlement != null) return true
        ports.transport.preparation(op.request, 256, false, guard) { retainPreparation(op.request, it) }; reload(guard)
        val recovery = recoverSaved(op.request, guard); reload(guard)
        if (operation().settlement == null) recoverFailure(op.request, guard)
        reload(guard)
        if (operation().continuation != null || operation().continuationObserved) recoverContinuation(op.request, null, guard)
        reload(guard)
        return recovery.preparation != null
    }
    private suspend fun recoverSaved(request: MiningTaxClaimsPrepareRequest, guard: () -> Unit): MiningTaxClaimsRecoveryEnvelope {
        var result: MiningTaxClaimsRecoveryEnvelope? = null
        observed(request.idempotencyKey) { observe ->
            ports.transport.saved(request.idempotencyKey, guard, observe, retainWire = { retainWire(request, it) }) { recovery ->
                withContext(NonCancellable) {
                    recovery.preparation?.let { store.acceptPreparation(request.idempotencyKey, it) }
                    val settlement = recovery.settlement
                    if (settlement != null) store.acceptRecovery(request.idempotencyKey, settlement.ordinal.toInt(),
                        Json.encodeToJsonElement(MiningTaxClaimsRecoveryEnvelope.serializer(), recovery))
                    result = recovery
                }
            }
        }
        guard(); return requireNotNull(result)
    }
    private suspend fun recoverContinuation(request: MiningTaxClaimsPrepareRequest, child: MiningTaxClaimsContinuationRequest?, guard: () -> Unit): MiningTaxClaimsContinuationEnvelope {
        var result: MiningTaxClaimsContinuationEnvelope? = null; var seen = false
        val responseOwned = AtomicBoolean()
        // The final pre-POST hold guard stops new effects. Its own owned link
        // observation must then drain without authorizing any additional action.
        val unheld = if (child != null) store.continuationGuard(store.read()) else null
        val effectGuard = { guard(); if (!responseOwned.get()) unheld?.invoke(); Unit }
        try { observed(request.idempotencyKey) { observe ->
            ports.transport.continuation(request.idempotencyKey, child, effectGuard,
                { ordinal -> responseOwned.set(true); observe(ordinal) },
                { responseOwned.set(true); store.observeContinuationKey(request.idempotencyKey); seen = true },
                { responseOwned.set(true); retainWire(request, it) }) { envelope ->
                withContext(NonCancellable) {
                    responseOwned.set(true)
                    if (envelope.continuation != null) store.acceptContinuation(request.idempotencyKey, envelope)
                    else check(store.read().operation?.continuation?.envelope == null) { "Saved tax link is temporarily unavailable" }
                    result = envelope
                }
            }
        } } finally { if (seen) withContext(NonCancellable) { store.observeContinuation(request.idempotencyKey) } }
        guard(); return requireNotNull(result)
    }
    private suspend fun recoverFailure(request: MiningTaxClaimsPrepareRequest, guard: () -> Unit): MiningTaxClaimsFailureEnvelope {
        var result: MiningTaxClaimsFailureEnvelope? = null
        var failureSeen = false
        try { observed(request.idempotencyKey) { observe ->
            ports.transport.failures(request.idempotencyKey, guard, observe, { retainWire(request, it) }, failureObserved = {
                store.observeFailureKey(request.idempotencyKey); failureSeen = true
            }) { failure ->
                withContext(NonCancellable) {
                    failure.recovery.preparation?.let { store.acceptPreparation(request.idempotencyKey, it) }
                    if (failure.failures.isNotEmpty()) store.acceptFailure(request.idempotencyKey,
                        Json.encodeToJsonElement(MiningTaxClaimsFailureEnvelope.serializer(), failure))
                    else failure.recovery.settlement?.let { settlement -> store.acceptRecovery(request.idempotencyKey, settlement.ordinal.toInt(),
                        Json.encodeToJsonElement(MiningTaxClaimsRecoveryEnvelope.serializer(), failure.recovery)) }
                    result = failure
                }
            }
        } } finally {
            if (failureSeen) withContext(NonCancellable) { store.observeFailure(request.idempotencyKey) }
        }
        guard(); return requireNotNull(result)
    }
    private fun fresh(review: Review) {
        val elapsed = Math.subtractExact(ports.clockMs(), review.started)
        check(elapsed >= 0 && elapsed < review.budget) { "Original tax consent expired; keep its recovery record" }
    }
    private suspend fun current(op: MiningTaxClaimsOperation, ordinal: Int, guard: () -> Unit): Review {
        val p = requireNotNull(op.preparation); val started = ports.clockMs(); require(started >= 0)
        val value = ports.transport.review(p, ordinal, guard); guard()
        val selected = requireNotNull(value.review) { "Current original tax review is unavailable" }
        require(value.status == "ready")
        if (ordinal == 1) {
            val setup = requireNotNull(op.setup?.settlement?.receipt)
            require(selected.paidFeeLamports == setup.feeLamports && selected.paidRentLamports == setup.rentLamports) { "Current review differs from paid original setup costs" }
        }
        val budget = Duration.between(Instant.parse(value.serverNow), Instant.parse(p.expiresAt)).toMillis()
        // User review and the later approval normally run in separate UI jobs. Keep
        // their session/admission/epoch binding without retaining the completed review job.
        val captured = ports.capture(true); val expectedEpoch = epoch.get()
        val consentGuard = { captured(); check(!closed.get() && epoch.get() == expectedEpoch) { "Review the original tax transaction again" } }
        guard(); consentGuard()
        return Review(MiningTaxClaimsReview(p, value), started, budget, consentGuard).also { fresh(it) }
    }
    suspend fun open() = action(false) { guard -> reviewed = null; mutable.value = mutable.value.copy(review = null); recoverOriginal(guard) }
    suspend fun recover() = open()
    suspend fun begin(round: String, spot: Long, caps: MiningTaxClaimsCaps) = action(true) { guard ->
        check(mutable.value.journal?.operation == null && !store.settlementHeld())
        val policy = requireNotNull(ports.policy()).copy().also { it.validate() }; val trust = requireNotNull(ports.trust()).copy()
        val count = ports.totalSpots(); val request = MiningTaxClaimsPrepareRequest(ports.key(), round, spot, caps.copy()).also { it.validate(count) }
        guard(); store.begin(requireNotNull(mutable.value.journal), request, count); reload(guard)
        require(pins(operation()) == trust to policy)
        guard(); store.prepareAttempt(requireNotNull(mutable.value.journal)); reload(guard)
        ports.transport.preparation(request, count, true, guard) { retainPreparation(request, it) }; reload(guard)
    }
    suspend fun review(ordinal: Int) = action(true) { guard ->
        reviewed = null; mutable.value = mutable.value.copy(review = null)
        check(recoverOriginal(guard)) { "Recover the original preparation before a new approval" }
        val op = operation(); selectable(op, ordinal); check(op.transactions.none { it.ordinal == ordinal })
        pins(op); val value = current(op, ordinal, guard); guard(); pins(op)
        reviewed = value; mutable.value = mutable.value.copy(review = value.value)
    }
    suspend fun sign(ordinal: Int) = action(true) { guard ->
        val consent = requireNotNull(reviewed) { "Review the original tax transaction before approving it" }
        require(consent.value.current.ordinal == ordinal.toLong()); consent.guard(); fresh(consent)
        check(recoverOriginal(guard)); val op = operation(); selectable(op, ordinal)
        check(op.preparation == consent.value.preparation && op.transactions.none { it.ordinal == ordinal })
        val unheld = store.effectGuard(requireNotNull(mutable.value.journal), ordinal); guard()
        val now = current(op, ordinal, guard); val (trust, policy) = pins(op)
        val effectGuard = { guard(); consent.guard(); fresh(consent); fresh(now); check(pins(op) == trust to policy); unheld() }
        effectGuard(); val prepared = MiningTaxClaimsCrypto.prepare(requireNotNull(op.preparation), trust, policy, ordinal); effectGuard()
        ports.live(op.preparation, ordinal, effectGuard); effectGuard()
        val wallet = ports.wallet; wallet.requireAvailable(effectGuard); effectGuard()
        store.signingAttempt(requireNotNull(mutable.value.journal), ordinal); reload(effectGuard)
        wallet.sign(prepared, { value ->
            val verified = prepared.verifySignedBase64(value.wire); require(verified == value)
            store.acceptSigned(op.request.idempotencyKey, ordinal, verified.wire)
        }, effectGuard)
        effectGuard(); val saved = store.read(); effectGuard(); require(saved.operation?.transactions?.find { it.ordinal == ordinal }?.signed != null)
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(effectGuard)
    }
    suspend fun submit(ordinal: Int) = action(true) { guard ->
        check(recoverOriginal(guard)); val op = operation(); selectable(op, ordinal)
        val custody = requireNotNull(op.transactions.find { it.ordinal == ordinal }); check(!custody.submitAttempted)
        val signed = requireNotNull(custody.signed); val p = requireNotNull(op.preparation)
        val unheld = store.effectGuard(requireNotNull(mutable.value.journal), ordinal); guard()
        val current = current(op, ordinal, guard); val (trust, policy) = pins(op)
        val responseOwned = AtomicBoolean()
        val effectGuard = {
            guard(); fresh(current); check(pins(op) == trust to policy)
            // Once this request owns its response no further effect follows. Its
            // own setup/paid observation must still drain and publish the saved hold.
            if (!responseOwned.get()) unheld()
        }
        effectGuard(); val prepared = MiningTaxClaimsCrypto.prepare(p, trust, policy, ordinal); effectGuard()
        require(MiningTaxClaimsSavedWire.from(prepared.verifySignedBase64(signed.wire)) == signed)
        ports.live(p, ordinal, effectGuard); effectGuard()
        store.submitAttempt(requireNotNull(mutable.value.journal), ordinal); reload(effectGuard)
        observed(op.request.idempotencyKey) { observe ->
            ports.transport.submit(op.request.idempotencyKey, signed.wire, effectGuard,
                { ordinal -> responseOwned.set(true); observe(ordinal) },
                { responseOwned.set(true); retainWire(op.request, it) }) { responseOwned.set(true) /* ACK cannot publish settlement. */ }
        }; reload(effectGuard)
        reviewed = null; mutable.value = mutable.value.copy(review = null)
    }
    suspend fun archive() = action(false) { guard ->
        val expected = requireNotNull(mutable.value.journal); check(expected.operation?.settlement != null)
        guard(); store.archive(expected); reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    /** CLOSE (owner rule 2026-10-06): a request with no recovered preparation retires only when the by-key prepare GET
     *  made here, while owning requests, answers `unknown` for its key. A preparation it returns is kept instead. No POST. */
    suspend fun archiveAbsent() = action(false) { guard ->
        val expected = requireNotNull(mutable.value.journal); val op = requireNotNull(expected.operation)
        check(op.preparation == null && op.transactions.isEmpty()) { "Recover the original tax preparation first" }
        var fresh: MiningTaxClaimsPreparationEnvelope? = null
        ports.transport.preparation(op.request, 256, false, guard) { retainPreparation(op.request, it); fresh = it }
        guard(); store.archiveAbsent(expected, requireNotNull(fresh), guard)
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun archiveFailed() = action(false) { guard ->
        val expected = requireNotNull(mutable.value.journal); val op = requireNotNull(expected.operation)
        val fresh = recoverFailure(op.request, guard)
        guard(); store.archiveFailed(expected, fresh, guard)
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun prepareContinuation(caps: MiningTaxClaimsCaps) {
        val owned = caps.copy().also { it.validate() }
        action(true) { guard ->
            reviewed = null; mutable.value = mutable.value.copy(review = null)
            check(recoverOriginal(guard)); val op = operation(); selectable(op, 1); pins(op)
            check(op.transactions.none { it.ordinal == 1 })
            recoverContinuation(op.request, null, guard); reload(guard)
            val request = MiningTaxClaimsContinuationRequest(ports.key(), owned).also { it.validate() }
            guard(); store.beginContinuation(requireNotNull(mutable.value.journal), request); reload(guard)
            store.continuationAttempt(requireNotNull(mutable.value.journal)); reload(guard)
            recoverContinuation(op.request, request, guard); reload(guard)
        }
    }
    suspend fun resumeContinuation() = action(true) { guard ->
        reviewed = null; mutable.value = mutable.value.copy(review = null)
        val expected = requireNotNull(mutable.value.journal); val op = requireNotNull(expected.operation); val intent = requireNotNull(op.continuation)
        pins(op); recoverSaved(op.request, guard); recoverFailure(op.request, guard)
        val link = recoverContinuation(op.request, null, guard); reload(guard)
        if (link.continuation != null) return@action
        guard(); store.resumeContinuationAttempt(expected); reload(guard)
        recoverContinuation(op.request, intent.request, guard); reload(guard)
    }
    suspend fun activateContinuation() = action(false) { guard ->
        val expected = requireNotNull(mutable.value.journal); val op = requireNotNull(expected.operation)
        check(op.continuation?.envelope != null)
        val parent = recoverSaved(op.request, guard); val failure = recoverFailure(op.request, guard)
        val link = recoverContinuation(op.request, null, guard)
        guard(); store.activateContinuation(expected, link, parent, failure, guard)
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun archived(key: String): MiningTaxClaimsArchive? {
        var result: MiningTaxClaimsArchive? = null
        action(false) { guard -> result = store.archived(key); guard() }
        return result
    }
}
