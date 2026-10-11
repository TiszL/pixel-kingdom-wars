package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.starter.*
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

data class StarterExpeditionReview(val command: StarterExpeditionCommand, val view: StarterExpeditionView,
    val epoch: Long, val generation: Long, val paidView: PaidStarterExpeditionView? = null)
enum class StarterExpeditionHydration { CURRENT_ORIGINAL_BASE, ORIGINAL_BASE_UNAVAILABLE }
data class StarterExpeditionState(val journal: StarterExpeditionJournal, val view: StarterExpeditionView? = null,
    val review: StarterExpeditionReview? = null, val busy: Boolean = false, val advertised: Boolean = false,
    val hydration: StarterExpeditionHydration? = null, val paidView: PaidStarterExpeditionView? = null)

/** Starter departure only. Foreground and history recovery are GET-only; returns are automatic.
 * Current admission uses the full server route and installation, never inferred readiness. */
class StarterExpeditionRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: StarterExpeditionStore, private val selectedBase: () -> String?,
    private val generation: () -> Long, private val directory: () -> BaseDirectory?,
    private val refreshAccount: suspend () -> Unit, private val hydrateSelected: suspend (publicationGuard: () -> Unit) -> Unit,
    private val actionsAllowed: () -> Boolean, private val key: () -> String = { UUID.randomUUID().toString() },
    private val captureDeparture: gg.pixelkingdomwars.nativeclient.fleetjourney.FleetDepartureCapture = { _, _ -> null }) {
    private val mutable = MutableStateFlow(StarterExpeditionState(store.read())); val state = mutable.asStateFlow()
    private val admission = Mutex(); @Volatile private var epoch = 0L
    private val transport = StarterExpeditionTransport(store, object : StarterExpeditionPort {
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) =
            api.getStarterExpedition(path, emptyMap(), guard, retain)
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit) =
            api.postStarterExpedition(path, body, guard, retain, refusal)
        override suspend fun postWithDeparture(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit,
            refusal: (ApiException) -> Unit, created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture) -> Unit) =
            api.postStarterExpeditionWithDeparture(path, body, guard, retain, refusal, created)
    }, captureDeparture)
    init { check(store.identity.wallet == session.wallet && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/')) }
    private fun current(e: Long) { holder.requireCurrent(session); check(epoch == e) { "The starter departure view closed. Check its saved receipt." } }
    private fun owned(base: String) {
        val dir = requireNotNull(directory())
        check(dir.enabled && dir.stableMutations && dir.bases.any { it.id == base && it.selectable }) { "Select the original active kingdom." }
    }
    private fun selected(e: Long, base: String, g: Long, admit: Boolean) {
        current(e); check(selectedBase() == base && generation() == g) { "The selected kingdom changed. Review starter departure again." }
        owned(base)
        if (admit) check(actionsAllowed()) { "Game orders are paused. Saved starter departure receipts remain available." }
    }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null, paidView = null, busy = false) } }
    fun invalidateAdmission() = dismiss()
    /** Join a previous view's bounded response drain before a foreground GET. Never retries a command. */
    suspend fun awaitIdle() { admission.withLock { holder.requireCurrent(session) } }
    private suspend fun <T> action(block: suspend (Long) -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "A starter departure request is already running." }
        val e = epoch
        try { mutable.update { it.copy(busy = true, journal = store.read()) }; return block(e) }
        finally {
            try { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false, journal = store.read(), review = if (epoch == e) it.review else null) } }
            finally { admission.unlock() }
        }
    }
    suspend fun check() = action { e -> transport.check { current(e) }; Unit }
    suspend fun checkArchived(originalKey: String) = action { e -> transport.checkArchived(originalKey) { current(e) }; Unit }

    private suspend fun fresh(e: Long, base: String, g: Long, admit: Boolean): StarterExpeditionView {
        val guard = { selected(e, base, g, admit) }
        guard(); refreshAccount(); guard()
        val view = StarterExpeditionView.from(api.getStarterExpedition("/starter-expeditions", mapOf("baseId" to base), guard))
        guard(); check(view.wallet == session.wallet && view.baseId == base) { "Starter departure inventory belongs to another account or kingdom." }
        return view
    }
    private suspend fun freshPaid(e: Long, base: String, g: Long, realm: Int, admit: Boolean): PaidStarterExpeditionView {
        validatePaidStarterSelection(base, realm.toString())
        val guard = { selected(e, base, g, admit) }; guard()
        val view = PaidStarterExpeditionView.from(api.getStarterExpedition("/starter-expeditions/paid-route",
            mapOf("baseId" to base, "realm" to realm.toString()), guard))
        guard(); check(view.wallet == session.wallet && view.baseId == base && view.realm == realm) { "Paid route belongs to another account, kingdom or realm." }
        return view
    }
    /** Selection is read-only. An explicit review must reread both facilities and the selected destination. */
    suspend fun selectPaidRealm(realm: Int) = action { e ->
        mutable.update { it.copy(review = null, paidView = null) }
        val base = requireNotNull(selectedBase()) { "Select an active kingdom." }; val g = generation()
        val view = fresh(e, base, g, admit = false); val paid = freshPaid(e, base, g, realm, admit = false)
        selected(e, base, g, admit = false)
        mutable.update { it.copy(view = view, paidView = paid, advertised = true) }
    }
    private suspend fun reviewPaid(e: Long, realm: Int, original: StarterExpeditionCommand? = null) {
        mutable.update { it.copy(review = null, paidView = null) }
        val base = original?.request?.baseId ?: requireNotNull(selectedBase()) { "Select an active kingdom." }; val g = generation()
        val view = fresh(e, base, g, admit = true); val paid = freshPaid(e, base, g, realm, admit = true)
        val command = original ?: StarterExpeditionCommand.reviewPaid(store.identity, view, paid, key())
        command.admitPaid(store.identity, view, paid)
        val guard = { selected(e, base, g, admit = true) }
        val saved = if (original == null) transport.beginPaid(command, view, paid, guard) else transport.check(guard)
        guard()
        mutable.update { it.copy(journal = saved, view = view, paidView = paid, advertised = true,
            review = if (saved.operation?.proof == null) StarterExpeditionReview(command, view, e, g, paid) else null) }
    }
    suspend fun reviewPaidDeparture(realm: Int) = action { e ->
        check(store.read().operation == null); reviewPaid(e, realm)
    }
    /** History is recovered first. An old server cannot advertise new commands through another feature. */
    suspend fun refresh() = action { e ->
        mutable.update { it.copy(review = null, view = null, paidView = null, advertised = false) }
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
    private suspend fun review(e: Long, original: StarterExpeditionCommand?, create: ((StarterExpeditionView) -> StarterExpeditionCommand)?) {
        mutable.update { it.copy(review = null) }
        val base = original?.request?.baseId ?: requireNotNull(selectedBase()) { "Select an active kingdom." }; val g = generation()
        val view = fresh(e, base, g, admit = true)
        val command = original ?: requireNotNull(create)(view); command.admit(store.identity, view)
        val guard = { selected(e, base, g, admit = true) }
        val saved = if (original == null) transport.begin(command, view, guard) else transport.check(guard)
        guard()
        mutable.update { it.copy(journal = saved, view = view, advertised = true,
            review = if (saved.operation?.proof == null) StarterExpeditionReview(command, view, e, g) else null) }
    }
    suspend fun reviewDeparture(routeId: String) = action { e ->
        check(store.read().operation == null)
        review(e, null) { StarterExpeditionCommand.review(store.identity, it, key(), routeId) }
    }
    /** Re-review always observes the original key before asking for current base admission. */
    suspend fun reviewSaved() = action { e ->
        val saved = transport.check { current(e) }; val original = requireNotNull(saved.operation)
        if (original.proof != null) { mutable.update { it.copy(review = null) }; return@action }
        check(original.refusal == null) { "Archive the original refusal before starting a new command." }
        if (original.command.route.routeId.startsWith("paid_")) {
            check(original.attemptRevision == null) { "Paid departure already attempted. Check its original receipt; it will not be sent again." }
            reviewPaid(e, paidStarterRealmIds.indexOf(original.command.route.realmId), original.command)
        } else review(e, original.command, null)
    }
    suspend fun confirm(review: StarterExpeditionReview) = action { e ->
        check(mutable.value.review === review && review.epoch == e)
        val guard = { current(e); check(mutable.value.review === review); selected(e, review.command.request.baseId, review.generation, admit = true) }
        current(e); check(store.read().operation?.command == review.command)
        val observed = transport.check { current(e) }
        if (observed.operation?.proof != null) { mutable.update { it.copy(review = null) }; return@action }
        val isPaid = review.command.route.routeId.startsWith("paid_")
        if (isPaid) check(observed.operation?.attemptRevision == null) { "Paid departure already attempted. Check its original receipt." }
        guard()
        val view = fresh(e, review.command.request.baseId, review.generation, admit = true); guard()
        val paid = if (isPaid) freshPaid(e, review.command.request.baseId, review.generation,
            requireNotNull(review.paidView).realm, admit = true) else null
        if (paid != null) review.command.admitPaid(store.identity, view, paid) else review.command.admit(store.identity, view)
        try { if (paid != null) transport.confirmPaid(observed, { view }, { paid }, guard) else transport.confirm(observed, { view }, guard) }
        finally { if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    }
    suspend fun archiveDraftOrRefusal() = action { e -> transport.archiveUnsentOrRefused(store.read()) { current(e) }; Unit }
    /** Archive accepted proof after a separate guarded current snapshot. Historical proof never supplies
     * current inventory. A failed authority/snapshot refresh preserves the active original receipt. */
    suspend fun finish() = action { e ->
        val expected = store.read(); val base = requireNotNull(expected.operation).command.request.baseId
        val guard = { current(e) }
        transport.finish(expected, guard) {
            refreshAccount(); guard(); val dir = requireNotNull(directory())
            check(dir.enabled && dir.stableMutations) { "Original kingdom authority cannot be established yet." }
            if (selectedBase() != base || dir.bases.none { it.id == base && it.selectable }) {
                mutable.update { it.copy(view = null, review = null, paidView = null, advertised = false, hydration = StarterExpeditionHydration.ORIGINAL_BASE_UNAVAILABLE) }
            } else {
                val g = generation(); val selectedGuard = { selected(e, base, g, admit = false) }
                val view = fresh(e, base, g, admit = false); selectedGuard()
                hydrateSelected(selectedGuard); selectedGuard(); refreshAccount(); selectedGuard()
                mutable.update { it.copy(view = view, review = null, paidView = null, advertised = true, hydration = StarterExpeditionHydration.CURRENT_ORIGINAL_BASE) }
            }
        }; Unit
    }
}
