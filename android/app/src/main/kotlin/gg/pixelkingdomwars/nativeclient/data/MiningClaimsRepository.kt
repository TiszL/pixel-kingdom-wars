package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.wallet.MiningClaimSigningTrust
import gg.pixelkingdomwars.nativeclient.wallet.PreparedMiningClaim
import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.withLock

/** Authenticated transport and current-view guards are supplied by the application.
 * Evidence callbacks synchronously commit to the original store before view rejection. */
interface MiningClaimsPorts {
    fun capture(newAction: Boolean): () -> Unit
    fun policy(): MiningClaimsProtocolPolicy?
    fun trust(): MiningClaimSigningTrust?
    fun key(): String
    fun clockMs(): Long
    suspend fun status(guard: () -> Unit): MiningClaimStatusView
    suspend fun prepare(request: MiningClaimPrepareRequest, guard: () -> Unit, retain: (MiningClaimPreparationView) -> Unit,
        refusal: (MiningClaimPrepareRefusal) -> Unit): MiningClaimPreparationView
    suspend fun preparation(key: String, guard: () -> Unit, retain: (MiningClaimPreparationEnvelope) -> Unit): MiningClaimPreparationEnvelope
    suspend fun claim(id: String, guard: () -> Unit, retain: (MiningClaimView) -> Unit): MiningClaimView
    suspend fun live(preparation: MiningClaimPreparationView, guard: () -> Unit)
    suspend fun sign(prepared: PreparedMiningClaim, guard: () -> Unit, retain: (MiningClaimSavedWire) -> Unit)
    suspend fun submit(request: MiningClaimSubmitRequest, guard: () -> Unit): MiningClaimSubmitResponse
    suspend fun reviewOrdinal(id:String,ordinal:Int,guard:()->Unit):MiningClaimOrdinalReview = error("Ordered mining is unavailable")
    suspend fun continuation(id:String,guard:()->Unit,retain:(MiningClaimContinuationEnvelope)->Unit):MiningClaimContinuationEnvelope = error("Ordered mining is unavailable")
    suspend fun continueClaim(id:String,key:String,guard:()->Unit,retain:(MiningClaimContinuationEnvelope)->Unit,refusal:(MiningOrderedRefusal)->Unit):MiningClaimContinuationEnvelope = error("Ordered mining is unavailable")
}
data class MiningClaimsState(val loaded: Boolean = false, val busy: Boolean = false, val journal: MiningClaimsJournal? = null,
    val status: MiningClaimStatusView? = null, val review: MiningClaimPreparationView? = null, val error: String? = null)

/** Claimant-paid signed bytes are independent from server custody and selected bases.
 * Only explicit begin/sign/submit perform side effects. Recovery is always GET-only. */
class MiningClaimsRepository(private val store: MiningClaimsStore, private val ports: MiningClaimsPorts) {
    private val mutable = MutableStateFlow(MiningClaimsState()); val state = mutable.asStateFlow()
    private data class Review(val preparation: MiningClaimPreparationView, val started: Long, val guard: () -> Unit, val ordinal:Int=0, val receipt:MiningClaimOrdinalReview?=null)
    private var reviewed: Review? = null
    @Volatile private var epoch = 0L
    suspend fun awaitIdle() { store.requests.withLock { } }
    fun dismiss() { epoch++; reviewed = null; mutable.value = mutable.value.copy(review = null) }
    private fun reload(guard: () -> Unit) { guard(); val j = store.read(); guard(); mutable.value = mutable.value.copy(loaded = true, journal = j) }
    private fun operation() = requireNotNull(mutable.value.journal?.operation) { "No saved mining claim." }
    private suspend fun action(newAction: Boolean, block: suspend (() -> Unit) -> Unit) {
        val captured = ports.capture(newAction); val originalEpoch = epoch
        val guard = { captured(); check(epoch == originalEpoch) { "The mining claim view changed. Check the saved claim." } }
        guard(); check(store.requests.tryLock()) { "Another request is handling this mining claim." }
        try {
            mutable.value = mutable.value.copy(busy = true, error = null); reload(guard); block(guard)
        } catch (error: Exception) {
            reviewed = null
            if (runCatching { guard() }.isSuccess) mutable.value = mutable.value.copy(review = null, error = error.message ?: "Check the saved mining claim.")
            throw error
        } finally {
            store.requests.unlock()
            if (runCatching { captured() }.isSuccess) mutable.value = mutable.value.copy(busy = false, review = if (epoch == originalEpoch) mutable.value.review else null)
        }
    }
    private fun fresh(p: MiningClaimPreparationView, started: Long) {
        val elapsed = Math.subtractExact(ports.clockMs(), started)
        val left = Math.subtractExact(Instant.parse(p.expiresAt).toEpochMilli(), Instant.parse(p.serverNow).toEpochMilli())
        check(elapsed >= 0 && left > 0 && elapsed < left) { "The fee estimate expired. Keep this claim for recovery." }
    }
    private suspend fun preparation(guard: () -> Unit): MiningClaimPreparationEnvelope {
        val op = operation(); val key = op.request.idempotencyKey
        val retain: (MiningClaimPreparationEnvelope) -> Unit = { envelope ->
            envelope.validate(op.policy); check(envelope.wallet == store.identity.wallet && envelope.idempotencyKey == key)
            val receipt = envelope.receipt
            if (receipt != null) store.acceptPreparation(key, receipt)
            else check(store.read().operation?.preparation == null) { "The saved preparation is temporarily unavailable." }
        }
        val result = ports.preparation(key, guard, retain); retain(result); guard(); reload(guard); return result
    }
    private suspend fun claim(guard: () -> Unit): MiningClaimView? {
        val op = operation(); val p = op.preparation ?: return null
        val retain: (MiningClaimView) -> Unit = { store.acceptClaim(op.request.idempotencyKey, it); Unit }
        val result = ports.claim(p.claimId, guard, retain); retain(result); guard(); reload(guard)
        return result
    }
    private suspend fun status(policy: MiningClaimsProtocolPolicy, guard: () -> Unit): MiningClaimStatusView {
        val view = ports.status(guard); view.validate(policy); guard(); check(view.wallet == store.identity.wallet)
        mutable.value = mutable.value.copy(status = view); return view
    }
    suspend fun open() = action(false) { guard ->
        reviewed = null; mutable.value = mutable.value.copy(review = null)
        if (mutable.value.journal?.operation != null) { preparation(guard); claim(guard) }
        val policy = ports.policy() ?: mutable.value.journal?.operation?.policy ?: mutable.value.journal?.archives?.lastOrNull()?.policy
        if (policy != null) status(policy, guard)
    }
    suspend fun begin(ordered:Boolean=false) = action(true) { guard ->
        check(mutable.value.journal?.operation == null) { "Recover the saved request first." }
        val policy = requireNotNull(ports.policy()) { "Claim configuration is unavailable." }; requireNotNull(ports.trust())
        val view = status(policy, guard); check(view.state == "ready" && view.preparationAllowed) { "New mining claims are unavailable." }
        if(ordered)check(view.features.claims.ordered==1&&ports.trust()?.orderedLookupTable!=null&&policy.orderedComputeUnitLimit!=null){"Ordered claims are not configured."}
        val request = MiningClaimPrepareRequest(ports.key(),if(ordered)"ordered-v0" else null); guard(); store.begin(store.read(), request.idempotencyKey, policy,request.profile); reload(guard)
        guard(); store.prepareAttempt(store.read()); reload(guard)
        val retain: (MiningClaimPreparationView) -> Unit = { store.acceptPreparation(request.idempotencyKey, it); Unit }
        val refusal: (MiningClaimPrepareRefusal) -> Unit = { store.prepareRefused(request.idempotencyKey, it); Unit }
        val result = ports.prepare(request, guard, retain, refusal); retain(result); guard(); reload(guard)
    }
    suspend fun review() = action(true) { guard ->
        reviewed = null; mutable.value = mutable.value.copy(review = null); val started = ports.clockMs()
        val p = requireNotNull(preparation(guard).receipt) { "The fee estimate has not been recovered." }; claim(guard)
        if(operation().ordered!=null){val op=operation();val ordinal=requireNotNull(nextMiningOrdinal(op));check(op.ordered!!.signed.none{it.ordinal==ordinal}&&op.claim?.transactions?.get(ordinal)?.signature==null);val receipt=ports.reviewOrdinal(p.claimId,ordinal,guard);bindReview(op,receipt,ordinal);fresh(p.copy(serverNow=receipt.observedAt),started);reviewed=Review(p,started,guard,ordinal,receipt);mutable.value=mutable.value.copy(review=p);return@action}
        check(operation().signed == null && operation().claim?.state !in setOf("settled", "failed")) { "Recover the saved signed claim." }
        val view = status(operation().policy, guard)
        check(view.state == "ready" && view.preparationAllowed && view.rootSequence == p.rootSequence) { "The original allocation is no longer ready." }
        fresh(p, started); reviewed = Review(p, started, guard); mutable.value = mutable.value.copy(review = p)
    }
    suspend fun sign() = action(true) { guard ->
        if(operation().ordered!=null){signOrdered(guard);return@action}
        val op = operation(); check(op.signed == null && op.claim?.state !in setOf("settled", "failed"))
        val review = requireNotNull(reviewed) { "Review the fee and account rent before wallet approval." }
        check(review.preparation.claimId == op.preparation?.claimId); review.guard(); fresh(review.preparation, review.started)
        val prepared = prepareMiningClaimsSigning(review.preparation, op.policy, requireNotNull(ports.trust()))
        guard(); review.guard(); ports.live(review.preparation, guard); guard(); review.guard(); fresh(review.preparation, review.started)
        store.signingAttempt(store.read()); reload(guard)
        // No view/session guard here: a valid late wallet result is original evidence.
        ports.sign(prepared, guard) { signed ->
            val saved = store.acceptSigned(op.request.idempotencyKey, signed.wire)
            check(saved.operation?.signed == signed) { "The wallet returned another signed claim." }
        }
        guard(); review.guard(); check(store.read().operation?.signed != null) { "The wallet did not return a saved signature." }
        reviewed = null; mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun submit() = action(true) { guard ->
        if(operation().ordered!=null){submitOrdered(guard);return@action}
        val op = operation(); check(!op.submitAttempted) { "This claim was already submitted. Check its receipt." }
        val signed = requireNotNull(op.signed) { "Approve and save the claim first." }; val started = ports.clockMs()
        val p = requireNotNull(preparation(guard).receipt); claim(guard)
        if (operation().claim?.state == "settled") return@action
        check(operation().claim?.state != "failed") { "The original transaction failed. Archive its verified receipt before preparing another claim." }
        val prepared = prepareMiningClaimsSigning(p, op.policy, requireNotNull(ports.trust()))
        val verified = prepared.verifySignedBase64(signed.wire)
        check(verified.ordinal == signed.ordinal && verified.signature == signed.signature)
        guard(); fresh(p, started); ports.live(p, guard); guard(); fresh(p, started)
        store.submitAttempt(store.read()); reload(guard)
        val result = ports.submit(MiningClaimSubmitRequest(p.claimId, signed.wire), guard); result.validate()
        check(result.claimId == p.claimId && result.signature == signed.signature) { "Check the original signed claim receipt." }
        guard(); claim(guard) // Even a `settled` POST acknowledgement is not the receipt.
    }
    suspend fun finish() = action(false) { guard ->
        claim(guard); guard(); store.finish(store.read()); reviewed = null
        mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun archiveRefusal() = action(false) { guard ->
        check(operation().prepareRefusal != null); val expected = store.read()
        val absent = preparation(guard); guard(); store.archiveRefusal(expected, absent); reload(guard)
    }
    /** CLOSE (owner rule 2026-10-06): the by-key preparation read made here, under the request lock, must answer `unknown`
     *  for exactly this key. A preparation it returns is saved instead and the close is refused. No POST, no wallet. */
    suspend fun archiveAbsent() = action(false) { guard ->
        val expected = store.read(); val op = requireNotNull(expected.operation) { "No saved mining claim." }
        check(op.prepareRefusal == null && op.preparation == null) { "Check the saved preparation first." }
        val absent = preparation(guard); guard(); store.archiveAbsent(expected, absent); reviewed = null
        mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    suspend fun archiveFailed() = action(false) { guard ->
        val expected = store.read(); check(expected.operation?.claim?.state == "failed" && (expected.operation.preparation?.transactions?.size == 1 || orderedFailedSetup(expected.operation))) { "Check the single-transaction failed claim first." }
        val proof = requireNotNull(claim(guard)); guard()
        // Ordered terminal custody persists during the authenticated GET. Bind
        // the refreshed original instead of rejecting its own new revision.
        val current = if(expected.operation?.ordered!=null)store.read() else expected
        check(current.operation?.request==expected.operation?.request)
        store.archiveFailed(current, proof); reviewed = null
        mutable.value = mutable.value.copy(review = null); reload(guard)
    }
    private fun bindReview(op:MiningClaimsOperation,r:MiningClaimOrdinalReview,ordinal:Int){
        val p=requireNotNull(op.preparation);r.bind(p,ordinal,op.ordered?.parent?.setup)
        if(ordinal==1){val before=requireNotNull(op.claim).transactions[0];check(before.landing=="finalized"&&before.signature==r.setup?.signature)}
    }
    private suspend fun signOrdered(guard:()->Unit){
        val op=operation();val o=requireNotNull(op.ordered);val review=requireNotNull(reviewed){"Review this transaction before approval."};val ordinal=review.ordinal
        check(ordinal==nextMiningOrdinal(op)&&o.signed.none{it.ordinal==ordinal}&&op.claim?.transactions?.get(ordinal)?.signature==null);review.guard();val p=requireNotNull(op.preparation);check(p.sameOriginal(review.preparation,op.policy));val initial=requireNotNull(review.receipt);fresh(p.copy(serverNow=initial.observedAt),review.started)
        val prepared=prepareMiningClaimsSigning(p,op.policy,requireNotNull(ports.trust()),ordinal);ports.live(p,guard);val current=ports.reviewOrdinal(p.claimId,ordinal,guard);bindReview(op,current,ordinal);check(current.setup==initial.setup&&current.messageSha256==initial.messageSha256);guard();review.guard();fresh(p.copy(serverNow=initial.observedAt),review.started)
        store.signingAttempt(store.read(),ordinal);reload(guard)
        ports.sign(prepared,guard){signed->val saved=store.acceptSigned(op.request.idempotencyKey,signed.wire,ordinal);check(saved.operation?.ordered?.signed?.singleOrNull{it.ordinal==ordinal}==signed)}
        guard();review.guard();check(store.read().operation?.ordered?.signed?.any{it.ordinal==ordinal}==true);reviewed=null;mutable.value=mutable.value.copy(review=null);reload(guard)
    }
    private suspend fun submitOrdered(guard:()->Unit){
        val p=requireNotNull(preparation(guard).receipt);claim(guard);val op=operation();if(op.claim?.state=="settled")return
        val ordinal=requireNotNull(nextMiningOrdinal(op));val wire=requireNotNull(op.ordered?.signed?.singleOrNull{it.ordinal==ordinal});val prepared=prepareMiningClaimsSigning(p,op.policy,requireNotNull(ports.trust()),ordinal);check(prepared.verifySignedBase64(wire.wire).signature==wire.signature)
        val started=ports.clockMs();val review=ports.reviewOrdinal(p.claimId,ordinal,guard);bindReview(op,review,ordinal);ports.live(p,guard);fresh(p.copy(serverNow=review.observedAt),started);guard();store.submitAttempt(store.read(),ordinal);reload(guard)
        val result=ports.submit(MiningClaimSubmitRequest(p.claimId,wire.wire),guard);result.validate();check(result.claimId==p.claimId&&result.signature==wire.signature);guard();claim(guard)
    }
    private suspend fun continuation(guard:()->Unit):MiningClaimContinuationEnvelope{
        val op=operation();val p=requireNotNull(op.preparation);val retain:(MiningClaimContinuationEnvelope)->Unit={store.acceptContinuation(op.request.idempotencyKey,it);Unit}
        val result=ports.continuation(p.claimId,guard,retain);retain(result);guard();reload(guard);return result
    }
    suspend fun checkContinuation()=action(false){guard->claim(guard);continuation(guard)}
    suspend fun continueOriginal()=action(true){guard->
        claim(guard);val op=operation();val o=requireNotNull(op.ordered);check(!o.held&&o.continuation==null);val p=requireNotNull(op.preparation)
        val key:String
        if(o.continuationRequest!=null){val lookup=continuation(guard);if(lookup.continuation!=null)return@action
            if(o.continuationRefusal==null)return@action // An uncertain attempt remains lookup-only.
            key=ports.key();store.renewContinuation(store.read(),key,lookup)
        }else{key=ports.key();store.continuationAttempt(store.read(),key)}
        reload(guard)
        val retain:(MiningClaimContinuationEnvelope)->Unit={store.acceptContinuation(op.request.idempotencyKey,it);Unit}
        val refusal:(MiningOrderedRefusal)->Unit={store.continuationRefused(op.request.idempotencyKey,it);Unit}
        val result=ports.continueClaim(p.claimId,key,guard,retain,refusal);retain(result);guard();reviewed=null;mutable.value=mutable.value.copy(review=null);reload(guard)
    }

    suspend fun useContinuation()=action(true){guard->continuation(guard);guard();store.useContinuation(store.read());reviewed=null;mutable.value=mutable.value.copy(review=null);reload(guard)}

}
