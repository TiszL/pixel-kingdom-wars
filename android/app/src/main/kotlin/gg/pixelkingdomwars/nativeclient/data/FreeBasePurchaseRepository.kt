package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.freebase.*
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.ApiException
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

data class FreeBasePurchaseReview(val command: FreeBasePurchaseCommand, val view: FreeBasePurchaseView, val epoch: Long, val generation: Long)
data class FreeBasePurchaseState(val journal: FreeBasePurchaseJournal, val view: FreeBasePurchaseView? = null,
    val review: FreeBasePurchaseReview? = null, val busy: Boolean = false)

/** Current admission is distinct from permanent original receipt recovery. Never publishes a receipt as a base. */
class FreeBasePurchaseRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: FreeBasePurchaseStore, private val selectedBase: () -> String?,
    private val generation: () -> Long, private val directory: () -> BaseDirectory?, private val refreshAccount: suspend () -> Unit,
    private val actionsAllowed: () -> Boolean, private val key: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(FreeBasePurchaseState(store.read())); val state = mutable.asStateFlow()
    private val admission = Mutex(); @Volatile private var epoch = 0L
    private val transport = FreeBasePurchaseTransport(store, object : FreeBasePurchasePort {
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) = api.getFreeBasePurchase(path, emptyMap(), guard, retain)
        override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit) = api.postFreeBasePurchase(body, guard, retain)
    })
    init { check(store.identity.wallet == session.wallet && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/')) }
    private fun current(e: Long) { holder.requireCurrent(session); check(epoch == e) { "The purchase view changed. Check the saved receipt." } }
    private fun selected(e: Long, base: String, g: Long, admit: Boolean) {
        current(e); check(selectedBase() == base && generation() == g) { "The selected kingdom changed. Review the purchase again." }
        check(directory()?.let { it.enabled && it.stableMutations && it.bases.any { b -> b.id == base && b.selectable } } == true)
        if (admit) check(actionsAllowed()) { "New game orders are paused. Saved receipts remain available." }
    }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null, busy = false) } }
    fun invalidateAdmission() = dismiss()
    suspend fun awaitIdle() { admission.withLock { holder.requireCurrent(session) } }
    private suspend fun <T> action(block: suspend (Long) -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "A purchase request is already running." }; val e = epoch
        try { mutable.update { it.copy(busy = true, journal = store.read()) }; return block(e) }
        finally { try { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false, journal = store.read(), review = if (e == epoch) it.review else null) } } finally { admission.unlock() } }
    }
    private suspend fun fresh(e: Long, base: String, g: Long, admit: Boolean): FreeBasePurchaseView {
        val guard = { selected(e, base, g, admit) }; guard(); refreshAccount(); guard()
        val view = FreeBasePurchaseView.from(api.getFreeBasePurchase("/bases/free-purchases", mapOf("sourceBaseId" to base), guard))
        guard(); check(view.wallet == session.wallet && view.sourceBaseId == base); return view
    }
    suspend fun check() = action { e -> transport.check { current(e) }; Unit }
    /** CLOSE: a fresh by-key read in the transport's lock must answer no receipt before [expected] is cleared. No POST. */
    suspend fun close(expected: FreeBasePurchaseJournal) = action { e ->
        mutable.update { it.copy(review = null) }; transport.close(expected) { current(e) }; Unit
    }
    suspend fun refresh() = action { e ->
        mutable.update { it.copy(view = null, review = null) }; transport.check { current(e) }; refreshAccount(); current(e)
        val selected = selectedBase(); val g = generation()
        val base = selected?.takeIf { id -> directory()?.let { it.enabled && it.stableMutations && it.bases.any { b -> b.id == id && b.selectable } } == true }
        val view = try {
            if (base != null) fresh(e, base, g, false) else {
                val guard = { current(e); check(selectedBase() == selected && generation() == g) }
                val historical = FreeBasePurchaseView.from(api.getFreeBasePurchase("/bases/free-purchases", emptyMap(), guard))
                guard(); check(historical.wallet == session.wallet && historical.sourceBaseId == null && !historical.admission.allowed)
                historical
            }
        } catch (error: ApiException) { if (error.status == 404) return@action else throw error }
        mutable.update { it.copy(view = view) }
    }
    suspend fun reviewPurchase() = action { e ->
        mutable.update { it.copy(review = null) }; val saved = transport.check { current(e) }
        if (saved.operation?.receipt != null) return@action
        val base = saved.operation?.command?.request?.sourceBaseId ?: requireNotNull(selectedBase()); val g = generation()
        val view = fresh(e, base, g, true)
        val command = saved.operation?.command ?: FreeBasePurchaseCommand.review(store.identity, view, key())
        command.admit(store.identity, view); val guard = { selected(e, base, g, true) }
        val next = if (saved.operation == null) transport.begin(command, view, guard) else saved
        guard(); mutable.update { it.copy(journal = next, view = view, review = FreeBasePurchaseReview(command, view, e, g)) }
    }
    suspend fun confirm(review: FreeBasePurchaseReview) = action { e ->
        check(mutable.value.review === review && review.epoch == e)
        val original = transport.check { current(e) }; if (original.operation?.receipt != null) { mutable.update { it.copy(review = null) }; return@action }
        val guard = { current(e); check(mutable.value.review === review); selected(e, review.command.request.sourceBaseId, review.generation, true) }
        guard(); val view = fresh(e, review.command.request.sourceBaseId, review.generation, true); guard()
        try { transport.confirm(original, { view }, guard); refreshAccount(); guard() }
        finally { if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    }
}
