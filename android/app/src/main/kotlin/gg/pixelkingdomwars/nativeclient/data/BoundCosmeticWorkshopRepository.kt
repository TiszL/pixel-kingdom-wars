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
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl

data class BoundCosmeticWorkshopReview(val command: BoundCosmeticCommand, val view: BoundCosmeticWorkshopView,
    val epoch: Long, val generation: Long)
data class BoundCosmeticWorkshopState(val journal: BoundCosmeticJournal, val view: BoundCosmeticWorkshopView? = null,
    val review: BoundCosmeticWorkshopReview? = null, val busy: Boolean = false, val advertised: Boolean = false,
    val preferenceChanged: Boolean = false)

/** Saved originals belong to the account. Current stock, consent and appearances belong to one
 * selected kingdom generation. Native art/application admission is independent of server readiness. */
class BoundCosmeticWorkshopRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: BoundCosmeticStore, private val rules: BoundCosmeticWorkshopRules,
    private val selectedBase: () -> String?, private val generation: () -> Long, private val directory: () -> BaseDirectory?,
    private val refreshAccount: suspend () -> Unit, private val hydrateSelected: suspend (() -> Unit) -> Unit,
    private val actionsAllowed: () -> Boolean, private val nativeApplicationReady: () -> Boolean,
    private val preview: suspend (BoundCosmeticAppearance, () -> Unit) -> Unit,
    private val key: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(BoundCosmeticWorkshopState(store.read())); val state = mutable.asStateFlow()
    private val originals = BoundCosmeticOriginalRecovery(api, store)
    private val admission = Mutex(); @Volatile private var epoch = 0L
    private var viewGeneration: Long? = null
    init { check(store.identity.wallet == session.wallet && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/')) }
    private fun current(e: Long) { holder.requireCurrent(session); check(epoch == e) { "The Workshop view changed. Check its saved original." } }
    private fun selected(e: Long, base: String?, g: Long, mutation: Boolean = false, application: Boolean = false) {
        current(e); check(selectedBase() == base && generation() == g) { "The selected kingdom changed. Review its appearance again." }
        if (mutation) {
            val dir = requireNotNull(directory())
            check(base != null && dir.enabled && dir.stableMutations && dir.bases.any { it.id == base && it.selectable }) { "Select the original active kingdom." }
            check(actionsAllowed()) { "Game orders are paused. Saved appearances remain available." }
        }
        if (application) check(nativeApplicationReady()) { "Awning art is not available in this client yet. Saved originals remain available." }
    }
    fun dismiss() {
        epoch++; viewGeneration = null
        if (holder.isCurrent(session)) mutable.update { it.copy(view = null, review = null, busy = false, advertised = false, preferenceChanged = false) }
    }
    fun invalidateAdmission() = dismiss()
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
    private fun retain(command: BoundCosmeticCommand, raw: JsonObject): BoundCosmeticProof =
        originals.retain(command, raw)
    private suspend fun original(command: BoundCosmeticCommand, guard: () -> Unit) {
        val saved = originals.observe(command, guard)
        mutable.update { it.copy(journal = saved) }
    }
    private suspend fun recover(e: Long) { store.read().operation?.command?.let { original(it) { current(e) } } }
    suspend fun check() = action { e -> recover(e) }
    suspend fun checkArchived(originalKey: String) = action { e ->
        val command = store.read().archives.single { it.command.key == originalKey }.command
        original(command) { current(e) }
    }
    private suspend fun fresh(e: Long, base: String?, g: Long, mutation: Boolean = false, application: Boolean = false): BoundCosmeticWorkshopView {
        val guard = { selected(e, base, g, mutation, application) }
        guard(); refreshAccount(); guard()
        val view = BoundCosmeticWorkshopView.from(api.getBoundCosmetic("/bound-cosmetics", base?.let { mapOf("baseId" to it) }.orEmpty(), guard), session.wallet, base, rules)
        guard()
        val journal = store.read()
        (journal.archives + listOfNotNull(journal.operation)).forEach { op ->
            view.originals.firstOrNull { it.idempotencyKey == op.command.key }?.let { store.accept(op.command, it) }
        }
        guard(); viewGeneration = g
        mutable.update { it.copy(journal = store.read(), view = view, advertised = true) }; return view
    }
    /** Discovery and current-source failure never suppress the independent original read. */
    suspend fun refresh(waitForIdle: Boolean = false) = action(waitForIdle) { e ->
        mutable.update { it.copy(view = null, review = null, advertised = false) }; viewGeneration = null
        var failure: Exception? = null
        try { fresh(e, selectedBase(), generation()) } catch (error: Exception) { if (error is CancellationException) throw error; current(e); failure = error }
        try { recover(e) } catch (error: Exception) { if (error is CancellationException) throw error; current(e); if (failure == null) failure = error }
        failure?.let { throw it }
    }
    private fun admit(view: BoundCosmeticWorkshopView, row: BoundCosmeticCatalogueRow) {
        check(view.applicationReady && nativeApplicationReady()) { "Awning application is unavailable." }
        check(view.acceptingJobs) { "New cosmetic crafting is paused." }
        val base = view.selectedBase as? BoundCosmeticSelectedBase.Available ?: error("Select a kingdom with verified ownership.")
        check(view.originals.none { it.receipt?.recipe?.outputId == row.recipe.outputId }) { "This appearance is already owned or being crafted." }
        check(view.blueprint.state == "eligible") { "Complete a refining job to earn the Artisan Finishes Blueprint." }
        check(base.workshops.isNotEmpty()) { "Complete a Workshop in this kingdom." }
        check(base.markets.any { it.level >= row.recipe.requiredFacility.level }) { "This Awning requires a higher completed Market level." }
        check(base.queue.isEmpty()) { "The Workshop is busy. Materials, equipment and appearances share its queue." }
        check(row.recipe.inputs.all { input -> base.craftingStock.single { it.itemId == input.itemId }.available.toBigInteger() >= input.quantity.toBigInteger() }) { "Gather the missing refined materials." }
    }
    private fun admitOriginal(view: BoundCosmeticWorkshopView, command: BoundCosmeticCommand) {
        val row = view.recipes.single { it.recipe.recipeId == command.recipe.recipeId }
        check(row.recipe == command.recipe && row.appearance == command.appearance) { "Saved terms changed. Keep this original for recovery." }
        admit(view, row)
    }
    suspend fun reviewStart(recipeId: String) = action { e ->
        check(store.read().operation == null) { "Resolve or archive the saved request first." }
        mutable.update { it.copy(review = null) }
        val base = requireNotNull(selectedBase()); val g = generation(); val guard = { selected(e, base, g, true, true) }
        val view = fresh(e, base, g, true, true); val row = view.recipes.single { it.recipe.recipeId == recipeId }; admit(view, row)
        preview(row.appearance, guard); guard()
        val command = BoundCosmeticCommand(BoundCosmeticRequest(key(), base, row.recipe.recipeId, row.recipe.recipeVersion, row.appearance.bindingSha256), row.recipe, row.appearance)
        val saved = store.begin(store.read(), command); guard()
        mutable.update { it.copy(journal = saved, review = BoundCosmeticWorkshopReview(requireNotNull(saved.operation).command, view, e, g)) }
    }
    suspend fun reviewSaved() = action { e ->
        mutable.update { it.copy(review = null) }; recover(e)
        val op = requireNotNull(store.read().operation); if (op.proof != null) return@action
        val command = op.command; val g = generation(); val guard = { selected(e, command.request.baseId, g, true, true) }
        val view = fresh(e, command.request.baseId, g, true, true)
        if (store.read().operation?.proof != null) return@action
        admitOriginal(view, command); preview(command.appearance, guard); guard()
        mutable.update { it.copy(review = BoundCosmeticWorkshopReview(command, view, e, g)) }
    }
    suspend fun confirm(review: BoundCosmeticWorkshopReview) = action { e ->
        check(mutable.value.review === review && review.epoch == e)
        val base = review.command.request.baseId
        val guard = { selected(e, base, review.generation, true, true) }
        try {
            guard(); check(store.read().operation?.command == review.command); recover(e)
            if (store.read().operation?.proof != null) return@action
            val view = fresh(e, base, review.generation, true, true)
            if (store.read().operation?.proof != null) return@action
            admitOriginal(view, review.command); preview(review.command.appearance, guard); guard()
            store.attempt(store.read()); guard()
            val raw = api.postBoundCosmetic("/bound-cosmetics/jobs", review.command.request.body(), guard) { retain(review.command, it) }
            check(retain(review.command, raw).status == "accepted") { "Acceptance is unknown. Check the saved original before resending." }
            guard(); fresh(e, base, review.generation, true); guard(); hydrateSelected(guard); guard()
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
        val shown = requireNotNull(mutable.value.view); val base = shown.selectedBase as? BoundCosmeticSelectedBase.Available ?: error("Refresh this kingdom first.")
        val g = requireNotNull(viewGeneration); val guard = { selected(e, base.baseId, g, true, enabled) }
        guard()
        if (enabled) {
            check(shown.applicationReady) { "Awning application is unavailable." }
            val outputs = base.markets.map { rules.completedMarketOutput(it.level) }.toSet()
            val owned = shown.originals.filter { it.completion != null && it.receipt?.recipe?.outputId in outputs }
            check(owned.isNotEmpty()) { "Craft the Awning for this Market's completed tier first." }
            owned.forEach { preview(requireNotNull(it.receipt).appearance, guard); guard() }
        }
        val request = BoundCosmeticPreferenceRequest(base.baseId, enabled, base.preference.revision)
        try {
            val reply = BoundCosmeticPreferenceResponse.from(api.putBoundCosmeticPreference(request.body(), guard)); guard(); reply.match(request)
            reply.visual.match(base.markets.map { BoundCosmeticVisualBuilding(it.buildingId, "market", it.level, false) }, rules.completedMarketOutput)
        } catch (error: ApiException) {
            if (error.code != "BOUND_COSMETIC_PREFERENCE_CHANGED") throw error
            guard(); fresh(e, base.baseId, g, true); guard()
            mutable.update { it.copy(preferenceChanged = true) }; return@action
        }
        guard(); fresh(e, base.baseId, g, true); guard(); hydrateSelected(guard); guard()
    }
}
