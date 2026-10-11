package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl.Companion.toHttpUrl

data class BoundCosmeticWakeWorkshopReview(val command: BoundCosmeticCommand, val view: BoundCosmeticWakeWorkshopView,
    val epoch: Long, val generation: Long, val admissionEpoch: Long)
data class BoundCosmeticWakeWorkshopState(val journal: BoundCosmeticJournal, val view: BoundCosmeticWakeWorkshopView? = null,
    val preference: BoundCosmeticWakePreferenceSnapshot? = null, val original: BoundCosmeticProof? = null,
    val accountApplicationReady: Boolean = false,
    val review: BoundCosmeticWakeWorkshopReview? = null, val busy: Boolean = false, val advertised: Boolean = false,
    val preferenceChanged: Boolean = false)

/** Explicit Wake sibling. C5 is a separate injected capability, absent by default. Account
 * preference and saved originals are independent of selected-kingdom stock and crafting admission. */
class BoundCosmeticWakeWorkshopRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: BoundCosmeticStore, private val maxConcurrentPerBase: () -> Int,
    private val selectedBase: () -> String?, private val generation: () -> Long, private val directory: () -> BaseDirectory?,
    private val refreshAccount: suspend () -> Unit, private val hydrateSelected: suspend (() -> Unit) -> Unit,
    private val actionsAllowed: () -> Boolean, private val mutationsAllowed: () -> Boolean,
    private val nativeApplicationReady: () -> Boolean = { false },
    private val preview: suspend (BoundCosmeticAppearance, () -> Unit) -> Unit = { _, _ -> error("Aurora application is unavailable in this client") },
    private val key: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(BoundCosmeticWakeWorkshopState(store.read())); val state = mutable.asStateFlow()
    private val originals = BoundCosmeticOriginalRecovery(api, store)
    private val admission = Mutex(); @Volatile private var epoch = 0L; @Volatile private var craftEpoch = 0L
    init { check(store.mode == BoundCosmeticMode.WAKE && store.identity.wallet == session.wallet &&
        store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/')) }
    private fun current(e: Long) { holder.requireCurrent(session); check(epoch == e) { "The Workshop view changed. Check its saved original." } }
    private fun accountMutation(e: Long) { current(e); check(mutationsAllowed()) { "Game orders are paused. Original receipts remain available." } }
    private fun selected(e: Long, base: String?, g: Long, a: Long, mutation: Boolean = false) {
        current(e); check(selectedBase() == base && generation() == g && craftEpoch == a) { "The selected kingdom or application changed. Review again." }
        if (mutation) {
            accountMutation(e)
            val dir = requireNotNull(directory())
            check(base != null && dir.enabled && dir.stableMutations && dir.bases.any { it.id == base && it.selectable }) { "Select the original active kingdom." }
            check(actionsAllowed()) { "New crafting is paused. Saved originals remain available." }
            check(nativeApplicationReady()) { "Aurora application is unavailable in this client." }
        }
    }
    /** Base/art changes retire craft consent, not account-level Off already in flight. */
    fun invalidateAdmission() {
        craftEpoch++
        if (holder.isCurrent(session)) mutable.update { it.copy(view = null, review = null, advertised = false) }
    }
    fun dismiss() {
        epoch++; craftEpoch++
        if (holder.isCurrent(session)) mutable.update { it.copy(view = null, preference = null, accountApplicationReady = false, review = null, busy = false, advertised = false, preferenceChanged = false) }
    }
    suspend fun awaitIdle() { admission.withLock { store.requests.withLock { holder.requireCurrent(session) } } }
    private suspend fun <T> action(waitForIdle: Boolean = false, block: suspend (Long) -> T): T {
        holder.requireCurrent(session); if (waitForIdle) admission.lock() else check(admission.tryLock()) { "A Workshop request is already running." }; val e = epoch
        try { holder.requireCurrent(session);
            mutable.update { it.copy(busy = true, preferenceChanged = false) }
            return store.requests.withLock { current(e); mutable.update { it.copy(journal = store.read()) }; block(e) }
        } finally {
            try { if (holder.isCurrent(session) && epoch == e) mutable.update { it.copy(busy = false, journal = store.read()) } }
            finally { admission.unlock() }
        }
    }
    private suspend fun original(command: BoundCosmeticCommand, guard: () -> Unit) {
        val saved = originals.observe(command, guard); mutable.update { it.copy(journal = saved) }
    }
    private suspend fun recover(e: Long) { store.read().operation?.command?.let { original(it) { current(e) } } }
    suspend fun check() = action { e -> recover(e) }
    suspend fun checkArchived(originalKey: String) = action { e ->
        original(store.read().archives.single { it.command.key == originalKey }.command) { current(e) }
    }
    private fun observe(view: BoundCosmeticWakeWorkshopView, guard: () -> Unit) {
        guard()
        view.original?.let { proof ->
            val journal = store.read()
            (journal.archives + listOfNotNull(journal.operation)).firstOrNull { it.command.key == proof.idempotencyKey }
                ?.let { store.accept(it.command, proof) }
        }
        guard()
        mutable.update { it.copy(journal = store.read(), preference = view.preference, original = view.original, accountApplicationReady = view.applicationReady) }
    }
    private suspend fun accountView(e: Long, guard: () -> Unit = { current(e) }): BoundCosmeticWakeWorkshopView {
        guard()
        val view = BoundCosmeticWakeWorkshopView.from(api.getBoundCosmetic("/bound-cosmetics/wakes/v1/workshop", emptyMap(), guard), session.wallet, null, maxConcurrentPerBase)
        guard(); observe(view, guard); return view
    }
    private suspend fun fresh(e: Long, base: String?, g: Long, a: Long, mutation: Boolean = false): BoundCosmeticWakeWorkshopView {
        val guard = { selected(e, base, g, a, mutation) }
        guard(); refreshAccount(); guard()
        val view = BoundCosmeticWakeWorkshopView.from(api.getBoundCosmetic("/bound-cosmetics/wakes/v1/workshop", base?.let { mapOf("baseId" to it) }.orEmpty(), guard), session.wallet, base, maxConcurrentPerBase)
        guard(); observe(view, guard); mutable.update { it.copy(view = view, advertised = true) }; return view
    }
    /** Current stock failure cannot suppress an independent account preference or original read. */
    suspend fun refresh(waitForIdle: Boolean = false) = action(waitForIdle) { e ->
        mutable.update { it.copy(view = null, review = null, advertised = false) }
        var failure: Exception? = null
        try { fresh(e, selectedBase(), generation(), craftEpoch) }
        catch (error: Exception) {
            if (error is CancellationException) throw error; current(e); failure = error
            try { accountView(e) } catch (accountError: Exception) { if (accountError is CancellationException) throw accountError; current(e) }
        }
        try { recover(e) } catch (error: Exception) { if (error is CancellationException) throw error; current(e); if (failure == null) failure = error }
        failure?.let { throw it }
    }
    suspend fun refreshPreference() = action { e -> accountView(e); Unit }
    private fun admit(view: BoundCosmeticWakeWorkshopView) {
        check(view.applicationReady && nativeApplicationReady()) { "Aurora application is unavailable." }
        check(view.acceptingJobs) { "New cosmetic crafting is paused." }
        val base = view.selectedBase as? BoundCosmeticWakeSelectedBase.Available ?: error("Select a kingdom with verified ownership.")
        check(view.original == null) { "Aurora Wake is already owned or being crafted." }
        check(view.blueprint.state == "eligible") { "Complete a refining job to earn the Artisan Finishes Blueprint." }
        check(base.workshops.isNotEmpty()) { "Complete a Workshop in this kingdom." }
        check(base.lodges.any { it.level >= view.recipe.recipe.requiredFacility.level }) { "Aurora requires a higher completed Lodge level." }
        check(base.queue.isEmpty()) { "The Workshop is busy. Materials, equipment and appearances share its queue." }
        check(view.recipe.recipe.inputs.all { input -> base.craftingStock.single { it.itemId == input.itemId }.available.toBigInteger() >= input.quantity.toBigInteger() }) { "Gather the missing refined materials." }
    }
    private fun admitOriginal(view: BoundCosmeticWakeWorkshopView, command: BoundCosmeticCommand) {
        check(view.recipe.recipe == command.recipe && view.recipe.appearance == command.appearance) { "Saved terms changed. Keep this original for recovery." }
        admit(view)
    }
    suspend fun reviewStart() = action { e ->
        check(store.read().operation == null) { "Resolve or archive the saved request first." }; mutable.update { it.copy(review = null) }
        val base = requireNotNull(selectedBase()); val g = generation(); val a = craftEpoch; val guard = { selected(e, base, g, a, true) }
        val view = fresh(e, base, g, a, true); admit(view); preview(view.recipe.appearance, guard); guard()
        val command = BoundCosmeticCommand(BoundCosmeticRequest(key(), base, view.recipe.recipe.recipeId, view.recipe.recipe.recipeVersion, view.recipe.appearance.bindingSha256), view.recipe.recipe, view.recipe.appearance)
        val saved = store.begin(store.read(), command); guard()
        mutable.update { it.copy(journal = saved, review = BoundCosmeticWakeWorkshopReview(requireNotNull(saved.operation).command, view, e, g, a)) }
    }
    suspend fun reviewSaved() = action { e ->
        mutable.update { it.copy(review = null) }; recover(e)
        val op = requireNotNull(store.read().operation); if (op.proof != null) return@action
        val c = op.command; val g = generation(); val a = craftEpoch; val guard = { selected(e, c.request.baseId, g, a, true) }
        val view = fresh(e, c.request.baseId, g, a, true)
        if (store.read().operation?.proof != null) return@action
        admitOriginal(view, c); preview(c.appearance, guard); guard()
        mutable.update { it.copy(review = BoundCosmeticWakeWorkshopReview(c, view, e, g, a)) }
    }
    suspend fun confirm(review: BoundCosmeticWakeWorkshopReview) = action { e ->
        check(mutable.value.review === review && review.epoch == e)
        val base = review.command.request.baseId; val guard = { selected(e, base, review.generation, review.admissionEpoch, true) }
        try {
            guard(); check(store.read().operation?.command == review.command); recover(e)
            if (store.read().operation?.proof != null) return@action
            val view = fresh(e, base, review.generation, review.admissionEpoch, true)
            if (store.read().operation?.proof != null) return@action
            admitOriginal(view, review.command); preview(review.command.appearance, guard); guard()
            store.attempt(store.read()); guard()
            val raw = api.postBoundCosmetic("/bound-cosmetics/wakes/v1/jobs", review.command.request.body(), guard) { originals.retain(review.command, it) }
            check(originals.retain(review.command, raw).status == "accepted") { "Acceptance is unknown. Check the saved original before resending." }
            guard(); fresh(e, base, review.generation, review.admissionEpoch); guard(); hydrateSelected(guard); guard()
        } finally { if (holder.isCurrent(session) && epoch == e) mutable.update { it.copy(review = null) } }
    }
    /** Owner rule 2026-10-06: no saved request blocks play forever. An attempted original without proof closes only on
     * THIS action's by-key "unknown"; if that same read shows acceptance, the close is refused and the receipt stays. */
    suspend fun archive() = action { e ->
        val before = store.read().operation; val unknownBefore = before != null && before.attempted && before.proof == null
        val reply = before?.let { op -> originals.observed(op.command) { current(e) }.let { (journal, proof) -> mutable.update { it.copy(journal = journal) }; proof } }
        current(e); val saved = store.read()
        saved.operation?.let { op ->
            check(!unknownBefore || op.proof == null) { "The server accepted this request. Its receipt stays saved here." }
            store.archive(saved, reply)
        }
        mutable.update { it.copy(journal = store.read(), review = null) }
    }
    suspend fun setPreference(enabled: Boolean) = action { e ->
        val shown = requireNotNull(mutable.value.preference) { "Refresh the account preference before changing it." }
        val guard = { accountMutation(e); if (enabled) check(nativeApplicationReady()) { "Aurora application is unavailable in this client." } }
        guard()
        var owned: BoundCosmeticAppearance? = null
        if (enabled) {
            val view = accountView(e, guard); val proof = view.original
            check(view.applicationReady && proof?.completion != null) { "Complete Aurora Wake crafting before enabling it." }
            owned = requireNotNull(proof?.receipt).appearance; preview(owned, guard); guard()
        }
        val request = BoundCosmeticWakePreferenceRequest(enabled, shown.revision)
        try {
            val reply = BoundCosmeticWakePreferenceResponse.from(api.putBoundCosmeticWakePreference(request.body(), guard))
            guard(); reply.match(request)
            val next = BoundCosmeticWakePreferenceSnapshot(reply.enabled, reply.revision, reply.visual).also { it.validate() }
            if (enabled && next.visual.state == "available") check(next.visual.visual?.wake == owned) { "The selected appearance changed. Refresh its account setting." }
            mutable.update { it.copy(preference = next) }
        } catch (error: Exception) {
            current(e); mutable.update { it.copy(preference = null) }
            if (error is ApiException && error.code == "BOUND_COSMETIC_PREFERENCE_CHANGED") {
                accountView(e, guard); mutable.update { it.copy(preferenceChanged = true) }; return@action
            }
            throw error
        }
    }
}
