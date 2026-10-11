package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.session.*
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class BaseClaimReview(val request: BaseClaimRequest, val epoch: Long)
data class BaseClaimState(val busy: Boolean = false, val loaded: Boolean = false, val offer: BaseClaimOffer? = null,
    val saved: SavedBaseClaim? = null, val review: BaseClaimReview? = null, val hydrated: Boolean = false, val error: String? = null)

/** Auth-only transfer recovery. It never changes a paid-land intent, selects a base, or signs a payment. */
class BaseClaimRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val journal: BaseClaimJournal, private val refreshAccount: suspend () -> Unit,
    private val newKey: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(BaseClaimState()); val state = mutable.asStateFlow()
    private val admission = Mutex(); private var epoch = 0L
    private suspend fun guard() { currentCoroutineContext().ensureActive(); holder.requireCurrent(session) }
    private fun interaction(captured: Long) { holder.requireCurrent(session); check(epoch == captured) { "Review this claim again after returning." } }
    private fun publish() { holder.requireCurrent(session); mutable.update { it.copy(saved = journal.read(), loaded = true) } }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    private suspend fun action(block: suspend () -> Unit) {
        if (!admission.tryLock()) return
        try { guard(); mutable.update { it.copy(busy = true, error = null) }; publish(); block() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { guard(); mutable.update { it.copy(error = error.message ?: "Claim unavailable. The saved deed is unchanged.") } }
        finally {
            try { if (holder.isCurrent(session)) {
                try { publish() } catch (_: Exception) { mutable.update { it.copy(loaded = false, offer = null, error = "The saved claim cannot be read. Unlock this device and check again.") } }
                mutable.update { it.copy(busy = false) }
            } } finally { admission.unlock() }
        }
    }
    private suspend fun offer(): BaseClaimOffer? {
        mutable.update { it.copy(offer = null) }
        val raw = try { api.get("$PATH/claimable") } catch (error: ApiException) { guard(); if (error.status == 404) return null else throw error }
        guard(); val value = BaseClaimOffer.from(raw); require(value.wallet == session.wallet)
        mutable.update { it.copy(offer = value) }; return value
    }
    private suspend fun accept(receipt: BaseClaimReceipt) {
        guard(); require(receipt.actor == session.wallet); journal.accept(receipt); publish()
        mutable.update { it.copy(hydrated = false) }
        refreshAccount(); guard()
        require(journal.read()?.receipt == receipt)
        mutable.update { it.copy(hydrated = true) }
    }
    private suspend fun observe(saved: SavedBaseClaim): BaseClaimStatus? {
        if (saved.cancelled) return null
        val raw = api.get("$PATH/${saved.request.idempotencyKey}"); guard()
        val status = BaseClaimStatus.from(raw, session.wallet, saved.request)
        require(saved.receipt == null || status.receipt == saved.receipt) { "The original receipt is unavailable. Its proof is retained." }
        status.receipt?.let { accept(it) }
        return status
    }
    suspend fun refresh() = action {
        journal.read()?.let { observe(it) }
        if (journal.read() == null) offer()
    }
    suspend fun review() = action {
        check(journal.read() == null) { "Resolve the original claim first." }
        val captured = epoch; val candidate = requireNotNull(offer()?.candidate) { "No transferable deed is available." }; interaction(captured)
        val request = BaseClaimRequest.from(BaseClaimRequest(newKey(), candidate.baseId, candidate.deedAssetId).json())
        mutable.update { it.copy(review = BaseClaimReview(request, captured), hydrated = false) }
    }
    suspend fun confirm(review: BaseClaimReview) = action {
        require(mutable.value.review == review); interaction(review.epoch); check(journal.read() == null)
        val candidate = offer()?.candidate; interaction(review.epoch)
        require(candidate == BaseClaimCandidate(review.request.baseId, review.request.deedAssetId)) { "The transferable deed changed. Review it again." }
        journal.begin(review.request); publish(); mutable.update { it.copy(review = null) }
        interaction(review.epoch); send(review.request)
    }
    private suspend fun send(request: BaseClaimRequest) {
        guard(); require(journal.read() == SavedBaseClaim(request))
        val raw = api.post(PATH, request.json()); guard()
        val receipt = BaseClaimReceipt.from(raw); require(receipt.request == request && receipt.actor == session.wallet)
        accept(receipt)
    }
    suspend fun retry() = action {
        val captured = epoch; val saved = requireNotNull(journal.read()); check(saved.receipt == null && !saved.cancelled)
        val status = requireNotNull(observe(saved)); interaction(captured)
        if (status.receipt == null) { check(status.enabled) { "New claims are disabled. Check or cancel the original request." }; send(saved.request) }
    }
    suspend fun cancel() = action {
        val captured = epoch; val saved = requireNotNull(journal.read()); check(saved.receipt == null && !saved.cancelled)
        interaction(captured)
        val raw = api.post("$PATH/${saved.request.idempotencyKey}/cancel-unaccepted", buildJsonObject {}); guard()
        val result = BaseClaimCancellation.from(raw, session.wallet, saved.request)
        if (result.cancelled) { journal.cancel(saved.request); publish() } else accept(requireNotNull(result.receipt))
    }
    suspend fun finish() = action {
        val saved = requireNotNull(journal.read()); check(saved.cancelled || saved.receipt != null && mutable.value.hydrated)
        journal.finish(saved); mutable.update { it.copy(hydrated = false) }; publish(); offer()
    }
    companion object { const val PATH = "/base/claims/v1" }
}
