package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.seeker.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl.Companion.toHttpUrl

data class SeekerShardsReview(val command: SeekerShardsClaimCommand, val row: SeekerShardsEntitlement, val epoch: Long, val generation: Long)
enum class SeekerShardsHydration { CURRENT_ORIGINAL_BASE, ORIGINAL_BASE_UNAVAILABLE }
data class SeekerShardsClaimsState(val journal: SeekerShardsClaimJournal, val view: SeekerShardsEntitlementView? = null,
    val review: SeekerShardsReview? = null, val busy: Boolean = false, val hydration: SeekerShardsHydration? = null)

/** Permanent original-wallet rights and current destination authority remain separate. */
class SeekerShardsClaimsRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val port: SeekerShardsClaimPort, private val store: SeekerShardsClaimStore, private val selectedBase: () -> String?,
    private val generation: () -> Long, private val directory: () -> BaseDirectory?, private val refreshAccount: suspend () -> Unit,
    private val hydrateSelected: suspend (guard: () -> Unit) -> Unit, private val actionsAllowed: () -> Boolean,
    private val key: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(SeekerShardsClaimsState(store.read())); val state = mutable.asStateFlow()
    private val admission = Mutex(); @Volatile private var epoch = 0L
    private val transport = SeekerShardsClaimTransport(store, port)
    init { check(store.identity.wallet == session.wallet && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/')) }
    private fun current(e: Long) { holder.requireCurrent(session); check(epoch == e) { "The claim view changed. Check the saved receipt." } }
    private fun owned(base: String) = directory()?.let { it.enabled && it.stableMutations && it.bases.any { b -> b.id == base && b.selectable } } == true
    private fun selected(e: Long, base: String, g: Long, admit: Boolean) {
        current(e); check(selectedBase() == base && generation() == g && owned(base)) { "Select the original destination kingdom again." }
        if (admit) check(actionsAllowed()) { "New claims are paused. Saved receipts remain available." }
    }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null, busy = false) } }
    fun invalidateAdmission() = dismiss()
    suspend fun awaitIdle() { admission.withLock { holder.requireCurrent(session) } }
    private suspend fun <T> action(block: suspend (Long) -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "A SHARDS claim request is already running." }; val e = epoch
        try { mutable.update { it.copy(busy = true, journal = store.read()) }; return block(e) }
        finally { try { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false, journal = store.read(), review = if (e == epoch) it.review else null) } } finally { admission.unlock() } }
    }
    private suspend fun page(e: Long, cursor: String?): SeekerShardsEntitlementView {
        val guard = { current(e) }; guard()
        val view = SeekerShardsEntitlementView.from(port.get("/seeker/shards/entitlements", cursor?.let { mapOf("cursor" to it) } ?: emptyMap(), guard) {}, store.policy)
        guard(); check(view.wallet == session.wallet && view.cursor == cursor); return view
    }
    suspend fun refresh(cursor: String? = null) = action { e ->
        mutable.update { it.copy(review = null, view = null) }; transport.check { current(e) }
        val view = try { page(e, cursor) } catch (error: ApiException) { if (error.status == 404) return@action else throw error }
        mutable.update { it.copy(view = view) }
    }
    suspend fun check() = action { e -> transport.check { current(e) }; Unit }
    suspend fun checkArchive(key: String) = action { e -> transport.checkArchive(key) { current(e) }; Unit }
    private suspend fun review(e: Long, existing: SeekerShardsClaimCommand?, row: SeekerShardsEntitlement?) {
        mutable.update { it.copy(review = null) }; val saved = transport.check { current(e) }
        check(saved.operation?.receipt == null && saved.operation?.attemptRevision == null)
        check(existing == saved.operation?.command)
        val base = existing?.request?.baseId ?: requireNotNull(selectedBase()); val g = generation()
        current(e); check(selectedBase() == base && generation() == g && actionsAllowed())
        refreshAccount(); selected(e, base, g, true)
        val cursor = if (existing != null) existing.browseCursor else mutable.value.view?.cursor
        val view = page(e, cursor); selected(e, base, g, true)
        val selectedRow = if (existing != null) view.rows.single { it.termId == existing.request.termId && it.spotId == existing.request.spotId }
            else requireNotNull(row).also { check(view.rows.contains(it)) { "SHARDS rights changed. Refresh and review again." } }
        val command = existing ?: SeekerShardsClaimCommand(SeekerShardsClaimRequest(key(), base, selectedRow.termId, selectedRow.spotId), selectedRow.termHash, cursor, store.policy)
        command.admit(store.identity, view, store.policy); val guard = { selected(e, base, g, true) }
        val next = if (existing == null) transport.begin(command, view, guard) else saved
        guard(); mutable.update { it.copy(journal = next, view = view, review = SeekerShardsReview(command, selectedRow, e, g)) }
    }
    suspend fun reviewClaim(row: SeekerShardsEntitlement) = action { e -> review(e, null, row) }
    suspend fun reviewSaved() = action { e -> review(e, requireNotNull(store.read().operation).command, null) }
    suspend fun confirm(review: SeekerShardsReview) = action { e ->
        check(mutable.value.review === review && review.epoch == e)
        val original = transport.check { current(e) }; if (original.operation?.receipt != null) { mutable.update { it.copy(review = null) }; return@action }
        val guard = { current(e); check(mutable.value.review === review); selected(e, review.command.request.baseId, review.generation, true) }
        guard(); refreshAccount(); guard(); val view = page(e, review.command.browseCursor); guard()
        try { transport.confirm(original, { view }, guard) }
        finally { if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    }
    /** CLOSE for an attempted claim: the transport's locked by-key read must answer no receipt first. No POST. */
    suspend fun archiveUnknown(expected: SeekerShardsClaimJournal) = action { e ->
        mutable.update { it.copy(review = null) }; transport.archiveUnknown(expected) { current(e) }; Unit
    }
    suspend fun abandonDraft() = action { e -> transport.abandonDraft { current(e) }; mutable.update { it.copy(review = null) } }
    suspend fun finish() = action { e ->
        val receipt = requireNotNull(store.read().operation?.receipt); var hydrated: SeekerShardsHydration? = null
        transport.finish({ current(e) }) {
            refreshAccount(); current(e)
            val refreshedDirectory = requireNotNull(directory())
            check(refreshedDirectory.selectorAvailable) { "Current kingdom authority is unavailable. Keep the saved receipt." }
            if (!refreshedDirectory.bases.any { it.id == receipt.baseId && it.selectable }) hydrated = SeekerShardsHydration.ORIGINAL_BASE_UNAVAILABLE
            else {
                val g = generation(); val guard = { selected(e, receipt.baseId, g, false) }; guard(); hydrateSelected(guard); guard()
                hydrated = SeekerShardsHydration.CURRENT_ORIGINAL_BASE
            }
        }
        mutable.update { it.copy(hydration = hydrated, review = null, view = null) }
    }
}
