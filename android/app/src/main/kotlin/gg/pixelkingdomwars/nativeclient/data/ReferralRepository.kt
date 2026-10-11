package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.session.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class ReferralReview(val code: String, val epoch: Long)
data class ReferralState(val loaded: Boolean = false, val supported: Boolean = false, val busy: Boolean = false,
    val status: ReferralStatus? = null, val saved: SavedReferral? = null, val review: ReferralReview? = null, val error: String? = null) {
    val canEnter get() = loaded && supported && !busy && status?.relationship == null && saved == null && review == null
}

/** Auth-only, independent of selected deed, admission, wallet signing and payment machinery. */
class ReferralRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val journal: ReferralJournal) {
    private val mutable = MutableStateFlow(ReferralState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var epoch = 0L
    private suspend fun guard() { currentCoroutineContext().ensureActive(); holder.requireCurrent(session) }
    private fun interaction(captured: Long) { holder.requireCurrent(session); check(epoch == captured) { "Review the referral again after returning to this screen." } }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    private fun publish() { holder.requireCurrent(session); val saved = journal.read(); mutable.update { it.copy(saved = saved, loaded = true) } }
    private suspend fun action(block: suspend () -> Unit) {
        if (!admission.tryLock()) return
        try { guard(); mutable.update { it.copy(busy = true, error = null) }; publish(); block() }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { guard(); mutable.update { it.copy(error = error.message ?: "Referral status is unavailable. The saved code is retained.") } }
        finally {
            try { if (holder.isCurrent(session)) {
                try { publish() } catch (_: Exception) { mutable.update { it.copy(loaded = false, supported = false, error = "The saved referral cannot be read. Unlock the device and check again.") } }
                mutable.update { it.copy(busy = false) }
            } } finally { admission.unlock() }
        }
    }
    private suspend fun readStatus(): ReferralStatus? {
        mutable.update { it.copy(supported = false) }
        val raw = try { api.get(STATUS) } catch (error: ApiException) {
            guard(); if (error.status == 404) return null else throw error
        }
        guard(); val status = ReferralStatus.from(raw); require(status.wallet == session.wallet)
        val known = journal.read()?.relationship
        require(known == null || known == status.relationship) { "The server did not return the saved immutable referral. Its proof is retained." }
        status.relationship?.let { journal.observe(it); guard() }
        mutable.update { it.copy(status = status, supported = true) }; publish()
        return status
    }
    suspend fun refresh() = action { readStatus() }
    suspend fun review(input: String) = action {
        val captured = epoch; val code = ReferralCode.normalize(input)
        check(readStatus() != null) { "Referral entry requires the server update." }; guard(); interaction(captured)
        check(journal.read() == null) { "This wallet already has a saved referral or relationship." }
        mutable.update { it.copy(review = ReferralReview(code, captured)) }
    }
    suspend fun confirm(review: ReferralReview) = action {
        check(mutable.value.review == review); interaction(review.epoch)
        check(readStatus() != null) { "Referral entry requires the server update." }; guard(); interaction(review.epoch)
        if (journal.read()?.relationship != null) { dismiss(); return@action }
        journal.begin(review.code); publish(); mutable.update { it.copy(review = null) }
        guard(); interaction(review.epoch); send(review.code, first = true)
    }
    suspend fun retry() = action {
        val saved = requireNotNull(journal.read()); val code = requireNotNull(saved.code)
        check(saved.relationship == null) { "The referral relationship is already known." }
        val captured = epoch
        check(readStatus() != null) { "The saved code is retained until referral recovery is supported." }; guard(); interaction(captured)
        if (journal.read()?.relationship == null) send(code, first = false)
    }
    /** CLOSE (owner rule 2026-10-06: no saved request blocks play forever). A fresh status read in this action must show
     *  no relationship for this wallet; a relationship found is kept instead. Never POSTs. */
    suspend fun close() = action {
        val saved = requireNotNull(journal.read()); val code = requireNotNull(saved.code)
        check(saved == SavedReferral(code)) { "The referral relationship is already known." }
        val status = checkNotNull(readStatus()) { "The saved code is retained until referral recovery is supported." }; guard()
        if (status.relationship == null) { journal.closeUnknown(code); publish() }
    }
    private suspend fun send(code: String, first: Boolean) {
        guard(); require(journal.read()?.code == code && journal.read()?.relationship == null)
        try {
            val raw = api.post(USE, buildJsonObject { put("code", code) }); guard()
            val result = ReferralUseResult.from(raw); require(result.wallet == session.wallet && result.code == code)
            journal.accept(code, result); guard(); publish()
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            guard()
            if (first && error is ApiException && ((error.status == 404 && error.code == "REFERRAL_CODE_UNKNOWN") ||
                    (error.status == 422 && error.code in setOf("REFERRAL_SELF", "REFERRAL_WINDOW_CLOSED")))) {
                journal.firstRefused(code); publish()
            }
            throw error
        }
    }
    suspend fun finish() = action { journal.finish(); publish() }
    companion object { const val STATUS = "/referrals/v1/status"; const val USE = "/referrals/v1/use" }
}
