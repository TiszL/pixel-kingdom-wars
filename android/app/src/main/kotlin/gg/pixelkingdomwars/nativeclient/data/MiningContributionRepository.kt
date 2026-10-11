package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.miningcontribution.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl

data class MiningContributionReview(val command: MiningContributionCommand, val view: MiningContributionView,
    val epoch: Long, val generation: Long)
enum class MiningContributionHydration { CURRENT_ORIGINAL_BASE, ORIGINAL_BASE_UNAVAILABLE }
data class MiningContributionState(val journal: MiningContributionJournal, val view: MiningContributionView? = null,
    val review: MiningContributionReview? = null, val busy: Boolean = false, val advertised: Boolean = false,
    val hydration: MiningContributionHydration? = null)

/** Resource commitment only. Foreground/history paths are GET-only; settlement is automatic.
 * Current availability is discovered from the exact base view, never Forge Ingot capabilities. */
class MiningContributionRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: MiningContributionStore, private val selectedBase: () -> String?,
    private val generation: () -> Long, private val directory: () -> BaseDirectory?,
    private val refreshAccount: suspend () -> Unit, private val hydrateSelected: suspend (publicationGuard: () -> Unit) -> Unit,
    private val actionsAllowed: () -> Boolean, private val key: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(MiningContributionState(store.read())); val state = mutable.asStateFlow()
    private val admission = Mutex(); @Volatile private var epoch = 0L
    private val transport = MiningContributionTransport(store, object : MiningContributionPort {
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) =
            api.getMiningContribution(path, emptyMap(), guard, retain)
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit) =
            api.postMiningContribution(path, body, guard, retain, refusal)
    })
    init { check(store.identity.wallet == session.wallet && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/')) }
    private fun current(e: Long) { holder.requireCurrent(session); check(epoch == e) { "The mining contribution view closed. Check its saved receipt." } }
    private fun owned(base: String) {
        val dir = requireNotNull(directory())
        check(dir.enabled && dir.stableMutations && dir.bases.any { it.id == base && it.selectable }) { "Select the original active kingdom." }
    }
    private fun selected(e: Long, base: String, g: Long, admit: Boolean) {
        current(e); check(selectedBase() == base && generation() == g) { "The selected kingdom changed. Review mining contribution again." }
        owned(base)
        if (admit) check(actionsAllowed()) { "Game orders are paused. Saved mining contribution receipts remain available." }
    }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null, busy = false) } }
    fun invalidateAdmission() = dismiss()
    /** Join a previous view's bounded response drain before a foreground GET. Never retries a command. */
    suspend fun awaitIdle() { admission.withLock { holder.requireCurrent(session) } }
    private suspend fun <T> action(block: suspend (Long) -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "A mining contribution request is already running." }
        val e = epoch
        try { mutable.update { it.copy(busy = true, journal = store.read()) }; return block(e) }
        finally {
            try { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false, journal = store.read(), review = if (epoch == e) it.review else null) } }
            finally { admission.unlock() }
        }
    }
    suspend fun check() = action { e -> transport.check { current(e) }; Unit }
    suspend fun checkArchived(originalKey: String) = action { e -> transport.checkArchived(originalKey) { current(e) }; Unit }

    private suspend fun fresh(e: Long, base: String, g: Long, admit: Boolean): MiningContributionView {
        val guard = { selected(e, base, g, admit) }
        guard(); refreshAccount(); guard()
        val view = MiningContributionView.from(api.getMiningContribution("/mining/contributions", mapOf("baseId" to base, "catalogueVersion" to "3"), guard))
        guard(); check(view.wallet == session.wallet && view.baseId == base) { "Mining contribution inventory belongs to another account or kingdom." }
        return view
    }
    /** History is recovered first. An old server cannot advertise new mining contribution through another feature. */
    suspend fun refresh() = action { e ->
        mutable.update { it.copy(review = null, view = null, advertised = false) }
        transport.check { current(e) }
        refreshAccount(); current(e)
        val base = selectedBase(); val g = generation()
        if (base != null && directory()?.let { it.enabled && it.stableMutations && it.bases.any { row -> row.id == base && row.selectable } } == true) {
            val view = try { fresh(e, base, g, admit = false) } catch (error: ApiException) {
                if (error.status != 404) throw error
                selected(e, base, g, admit = false); return@action
            }
            selected(e, base, g, admit = false)
            mutable.update { it.copy(view = view, advertised = true) }
        }
    }
    private suspend fun review(e: Long, original: MiningContributionCommand?, create: ((MiningContributionView) -> MiningContributionCommand)?) {
        mutable.update { it.copy(review = null) }
        val base = original?.request?.baseId ?: requireNotNull(selectedBase()) { "Select an active kingdom." }; val g = generation()
        val view = fresh(e, base, g, admit = true)
        val command = original ?: requireNotNull(create)(view); command.admit(store.identity, view)
        val guard = { selected(e, base, g, admit = true) }
        val saved = if (original == null) transport.begin(command, view, guard) else transport.check(guard)
        guard()
        mutable.update { it.copy(journal = saved, view = view, advertised = true,
            review = if (saved.operation?.proof == null) MiningContributionReview(command, view, e, g) else null) }
    }
    suspend fun reviewStart(lines: List<MiningContributionLine>) = action { e ->
        check(store.read().operation == null)
        review(e, null) { MiningContributionCommand.review(store.identity, it, key(), lines) }
    }
    /** Re-review always observes the original key before asking for current base admission. */
    suspend fun reviewSaved() = action { e ->
        val saved = transport.check { current(e) }; val original = requireNotNull(saved.operation)
        if (original.proof != null) { mutable.update { it.copy(review = null) }; return@action }
        check(original.refusal == null) { "Archive the original refusal before starting a new command." }
        review(e, original.command, null)
    }
    suspend fun confirm(review: MiningContributionReview) = action { e ->
        check(mutable.value.review === review && review.epoch == e)
        val guard = { current(e); check(mutable.value.review === review); selected(e, review.command.request.baseId, review.generation, admit = true) }
        current(e); check(store.read().operation?.command == review.command)
        val observed = transport.check { current(e) }
        if (observed.operation?.proof != null) { mutable.update { it.copy(review = null) }; return@action }
        guard()
        val view = fresh(e, review.command.request.baseId, review.generation, admit = true); guard()
        review.command.admit(store.identity, view)
        check(view.pool == review.view.pool && view.dailyCapValue == review.view.dailyCapValue && view.consistency == review.view.consistency) {
            "Mining qualification or allowance changed. Review the same basket again."
        }
        try { transport.confirm(observed, { view }, guard) }
        finally { if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    }
    suspend fun archiveDraftOrRefusal() = action { e -> transport.archiveUnsentOrRefused(store.read()) { current(e) }; Unit }
    /** CLOSE an attempted basket the server has no record of (fresh by-key read first). No POST. */
    suspend fun archiveUnknown() = action { e -> transport.archiveUnknown(store.read()) { current(e) }; Unit }
    /** Archive the accepted contribution, not a collect operation. Daily settlement remains GET-recoverable
     * in history. A failed authority/inventory refresh cannot erase the original accepted receipt. */
    suspend fun finish() = action { e ->
        val expected = store.read(); val base = requireNotNull(expected.operation).command.request.baseId
        val guard = { current(e) }
        transport.finish(expected, guard) {
            refreshAccount(); guard(); val dir = requireNotNull(directory())
            check(dir.enabled && dir.stableMutations) { "Original kingdom authority cannot be established yet." }
            if (selectedBase() != base || dir.bases.none { it.id == base && it.selectable }) {
                mutable.update { it.copy(view = null, review = null, advertised = false, hydration = MiningContributionHydration.ORIGINAL_BASE_UNAVAILABLE) }
            } else {
                val g = generation(); val selectedGuard = { selected(e, base, g, admit = false) }
                val view = fresh(e, base, g, admit = false); selectedGuard()
                hydrateSelected(selectedGuard); selectedGuard(); refreshAccount(); selectedGuard()
                mutable.update { it.copy(view = view, review = null, advertised = true, hydration = MiningContributionHydration.CURRENT_ORIGINAL_BASE) }
            }
        }; Unit
    }
}
