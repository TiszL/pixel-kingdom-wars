package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.io.IOException
import java.util.UUID
import java.time.LocalDate
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class ForgeClaimReview(val baseId: String?, val day: String?, val batchMax: Int, val epoch: Long, val selectedBase: String?)
data class ForgeClaimRefresh(val keepBalance: String?, val unavailable: String?,
    val availabilityCurrent: Boolean = true, val availabilityUnavailable: String? = null)
enum class ForgeClaimPhase { AVAILABLE, REVIEW, COLLECTING, CHECKING, UPDATING, SUCCESS }
class ForgeClaimRefreshException(cause: Exception) : IOException("Collected. Reconnect to update your balance and available KEEP.", cause)
data class ForgeClaimsState(val pending: PendingIntent? = null, val busy: Boolean = false, val supported: Boolean = false,
    val enabled: Boolean = false, val review: ForgeClaimReview? = null, val receipt: ForgeClaimReceipt? = null,
    val payout: ForgeClaimRefresh? = null, val phase: ForgeClaimPhase = ForgeClaimPhase.AVAILABLE,
    val refreshRequired: Boolean = false, val refreshError: String? = null,
    /** The saved key whose claim offers CLOSE (owner review 2026-10-06: never sent, or a settled server `absent` answer;
     * `unknown` only stops it blocking). */
    val serverUnknownKey: String? = null)

/** Claim history is auth-only. Base allocations identify the earned cycle; their
 * payout is always the original actor's wallet KEEP, never base SHARDS. */
class ForgeClaimsRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: PendingIntentStore, private val observer: ReceiptObserver,
    private val selectedBaseId: () -> String?, private val directory: () -> BaseDirectory?, private val landOwned: () -> Boolean,
    private val refreshAccount: suspend () -> Unit, private val batchMax: () -> Int?, cluster: String,
    private val invalidateViews: () -> Unit,
    private val refreshViews: suspend (originalBase: String?, unavailable: String?) -> ForgeClaimRefresh,
    private val refreshHome: suspend () -> Unit) {
    private val mutable = MutableStateFlow(ForgeClaimsState()); val state = mutable.asStateFlow()
    private val admission = Mutex(); private var epoch = 0L; private var actionEpoch: Long? = null
    private var permittedKey: String? = null; private var actionBase: String? = null; private var requireSameSelection = false
    private val spec = ForgeClaimSpec(cluster)
    private suspend fun guard() {
        currentCoroutineContext().ensureActive(); holder.requireCurrent(session)
        check(actionEpoch == null || actionEpoch == epoch) { "The Forge view changed. Check the original saved claim." }
        check(!requireSameSelection || actionBase == selectedBaseId()) { "The selected base changed. Review the original claim again." }
    }
    private suspend fun <T> bounded(read: suspend () -> T): T { guard(); return read().also { guard() } }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null,
        phase = if (it.phase == ForgeClaimPhase.REVIEW) if (it.receipt != null) ForgeClaimPhase.SUCCESS else ForgeClaimPhase.AVAILABLE else it.phase) } }
    private val op = MoneyOp(spec, store, object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = bounded { api.get(path, query) }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            check(actionEpoch != null && permittedKey != null && body.string("idempotencyKey") == permittedKey && path == spec.path) {
                "Open the Gold Forge to explicitly confirm the original claim."
            }; guard()
            invalidateViews(); mutable.update { it.copy(refreshRequired = true) }
            // A missing route, ordinary refusal or interrupted reply cannot retire
            // a claim key; only its matching immutable receipt proves the result.
            return try { bounded { api.post(path, body) } }
            catch (error: ApiException) { throw IOException("Claim outcome is unconfirmed. Check the original saved receipt.", error) }
        }
    })
    init { observer.register(op, ::hydrate) }
    private suspend fun <T> action(selected: Boolean = false, block: suspend () -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "A Forge claim is already in progress." }
        actionEpoch = epoch; actionBase = selectedBaseId(); requireSameSelection = selected
        mutable.update { it.copy(busy = true) }
        try { guard(); return block() } finally {
            actionEpoch = null; permittedKey = null; requireSameSelection = false
            try { if (holder.isCurrent(session)) { observer.refresh(session.wallet); holder.requireCurrent(session)
                mutable.update { it.copy(pending = op.pending(session.wallet), busy = false) } } } finally { admission.unlock() }
        }
    }
    private suspend fun probe(): Boolean {
        mutable.update { it.copy(supported = false, enabled = false) }
        val key = UUID.randomUUID().toString(); val max = requireNotNull(batchMax()) { "Load the verified Forge contract first." }
        val raw = try { bounded { api.get("${spec.path}/$key") } }
        catch (error: ApiException) { guard(); if (error.status == 404) return false else throw error }
        val status = ForgeClaimStatus.from(raw, max)
        require(status.wallet == session.wallet && status.idempotencyKey == key && status.receipt == null)
        mutable.update { it.copy(supported = true, enabled = status.enabled) }; return status.enabled
    }
    suspend fun refresh() = action {
        if (op.pending(session.wallet) != null) mutable.update { it.copy(phase = ForgeClaimPhase.CHECKING) }
        val observed = op.observe(session.wallet, ::hydrate)
        mutable.update { it.copy(serverUnknownKey = op.pending(session.wallet)?.idempotencyKey?.takeIf { observed != null && op.closable(session.wallet) }) }
        if (observed == null) mutable.value.receipt?.let { hydrateProof(it) }
        probe(); Unit
    }
    /** The saved claim's CLOSE (owner 2026-10-06): the existing MoneyOp closure. It reads the receipt once more; an acceptance
     * found there is hydrated as usual, and only a settled server `absent` answer for this exact key archives it on this device (re-read on every Home resume). No POST.
     * Closed means the server holds no record of the key, so the balance gate its POST raised ([ForgeClaimsState.refreshRequired])
     * is lifted with it; a new collection still re-reads the allocations before consent. */
    suspend fun close(): Receipt<*>? = action {
        val result = op.close(session.wallet, confirmed = true, ::hydrate)
        mutable.update { state -> if (result is Receipt.Closed) state.copy(serverUnknownKey = null, refreshRequired = false,
            phase = ForgeClaimPhase.AVAILABLE) else state.copy(serverUnknownKey = null) }
        result
    }
    private fun allocationScope(): String? = if (landOwned()) selectedBaseId() else null
    private fun originalAvailable(base: String?) {
        if (base == null) return // Original wallet allocations remain claimable after land loss and mode changes.
        val dir = requireNotNull(directory()) { "Refresh the original deed directory." }
        check(dir.stableMutations && dir.bases.any { it.id == base && it.selectable }) { "The original allocation deed is unavailable. Keep the claim saved; its scope cannot change." }
    }
    suspend fun review(base: String?, day: String?) = action(selected = true) {
        check(op.blocking(session.wallet) == null) { "Check the original Forge claim before starting another." }
        check(!mutable.value.refreshRequired) { "Update your balance and available KEEP before collecting again." }
        day?.let(ForgeClaimContract::day); bounded { refreshAccount() }
        require(base == allocationScope()) { "The allocation scope changed. Refresh the Gold Forge first." }; originalAvailable(base)
        check(probe()) { "Forge claims need available v1 support. Saved history remains available." }
        val max = requireNotNull(batchMax()); require(max > 0)
        // Refresh the exact allocation scope for consent. Current totals are never
        // used as the receipt or a prediction of which rows a concurrent claim wins.
        val query = buildMap { base?.let { put("baseId", it) }; day?.let { put("before", LocalDate.parse(it).plusDays(1).toString()) } }
        val allocations = ForgeAllocations.from(bounded { api.get("/forge/allocations", query) })
        require(if (day == null) allocations.claimable.toBigDecimal().signum() > 0 else allocations.days.any { it.day == day && it.status == "claimable" }) {
            "Nothing ready to collect."
        }
        mutable.update { it.copy(review = ForgeClaimReview(base, day, max, epoch, selectedBaseId()), phase = ForgeClaimPhase.REVIEW) }
    }
    suspend fun confirm(review: ForgeClaimReview) = action(selected = true) {
        check(mutable.value.review == review && review.epoch == epoch && review.selectedBase == selectedBaseId()) { "Review this claim again." }
        check(op.blocking(session.wallet) == null) { "Check the original Forge claim first." }
        bounded { refreshAccount() }; require(review.baseId == allocationScope()); originalAvailable(review.baseId)
        check(probe()) { "Forge claims are unavailable. No new claim was submitted." }
        require(batchMax() == review.batchMax) { "The Forge contract changed. Review again." }; guard()
        val intent = spec.intent(session.wallet, UUID.randomUUID().toString(), review.baseId, review.day, review.batchMax)
        permittedKey = intent.idempotencyKey
        mutable.update { it.copy(review = null, receipt = null, payout = null, refreshError = null,
            phase = ForgeClaimPhase.COLLECTING) }
        try { op.submit(intent, ::hydrate) }
        finally { if (holder.isCurrent(session) && mutable.value.phase == ForgeClaimPhase.COLLECTING)
            mutable.update { it.copy(phase = ForgeClaimPhase.CHECKING) } }
        Unit
    }
    suspend fun retry() = action(selected = true) {
        val saved = requireNotNull(op.pending(session.wallet)); spec.validate(saved)
        mutable.update { it.copy(phase = ForgeClaimPhase.CHECKING) }
        val observed = op.observe(session.wallet, ::hydrate)
        if (observed == Receipt.Unsupported) mutable.update { it.copy(supported = false, enabled = false) }
        if (observed != Receipt.Unknown && observed != Receipt.Absent) return@action
        check(probe()) { "Keep the original claim saved until this server enables v1 claims." }
        bounded { refreshAccount() }; originalAvailable(saved.baseId); guard()
        permittedKey = saved.idempotencyKey; invalidateViews()
        mutable.update { it.copy(phase = ForgeClaimPhase.COLLECTING, refreshRequired = true) }
        try { op.retry(session.wallet, ::hydrate) }
        finally { if (holder.isCurrent(session) && mutable.value.phase == ForgeClaimPhase.COLLECTING)
            mutable.update { it.copy(phase = ForgeClaimPhase.CHECKING) } }
        Unit
    }
    private suspend fun hydrate(accepted: Receipt.Accepted<ForgeClaimReceipt>) = hydrateProof(accepted.value)
    private suspend fun hydrateProof(proof: ForgeClaimReceipt) {
        guard()
        // MoneyOp has already durably saved this exact proof. Display it before any fallible read.
        invalidateViews()
        mutable.update { it.copy(receipt = proof, payout = null, phase = ForgeClaimPhase.UPDATING,
            refreshRequired = true, refreshError = null) }
        try {
            bounded { refreshAccount() }
            val dir = requireNotNull(directory()) { "Refresh the account directory before finishing the claim." }
            val unavailable = when {
                proof.baseId == null && dir.enabled -> "The original wallet allocation balance is unavailable in this account mode."
                proof.baseId != null && (!dir.enabled || !dir.bases.any { it.id == proof.baseId && it.selectable }) -> "The original allocation deed is unavailable for a balance refresh."
                else -> null
            }
            var refreshed = bounded { refreshViews(proof.baseId, unavailable) }
            if (refreshed.availabilityCurrent) {
                try { bounded { refreshHome() } }
                catch (error: CancellationException) { throw error }
                catch (_: Exception) {
                    guard()
                    refreshed = refreshed.copy(availabilityCurrent = false,
                        availabilityUnavailable = "Collected. Your Home balance could not be updated.")
                }
            }
            check(directory() == dir) { "The original directory changed during the balance refresh. Check the saved receipt again." }
            guard(); mutable.update { it.copy(payout = refreshed, phase = ForgeClaimPhase.SUCCESS,
                refreshRequired = !refreshed.availabilityCurrent, refreshError = refreshed.availabilityUnavailable) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            guard()
            mutable.update { it.copy(phase = ForgeClaimPhase.SUCCESS, refreshError = "Collected. Reconnect to update your balance and available KEEP.") }
            // Retain the saved receipt: a later refresh only hydrates it, never resends the claim.
            throw ForgeClaimRefreshException(error)
        }
    }
}
