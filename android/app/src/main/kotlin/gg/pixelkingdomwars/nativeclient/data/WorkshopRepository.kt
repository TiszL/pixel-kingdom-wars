package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.NativeCapabilities
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.workshop.*
import java.time.Instant
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class WorkshopReview(val command: WorkshopCommand, val view: WorkshopView, val shards: String,
    val epoch: Long, val generation: Long, val wall: Long, val elapsed: Long)
enum class WorkshopHydration { CURRENT_ORIGINAL_BASE, ORIGINAL_BASE_UNAVAILABLE }
data class WorkshopState(val journal: WorkshopJournal, val view: WorkshopView? = null, val shards: String? = null,
    val review: WorkshopReview? = null, val busy: Boolean = false, val advertised: Boolean = false, val hydration: WorkshopHydration? = null)

/** Session-bound Workshop commands and historical recovery. No observer or lifecycle path can POST. */
class WorkshopRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: WorkshopStore, private val selectedBase: () -> String?,
    private val generation: () -> Long, private val directory: () -> BaseDirectory?,
    private val refreshAccount: suspend () -> Unit, private val hydrateSelected: suspend (publicationGuard: () -> Unit) -> Unit,
    private val actionsAllowed: () -> Boolean, private val elapsed: () -> Long,
    private val wall: () -> Long = System::currentTimeMillis, private val key: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(WorkshopState(store.read())); val state = mutable.asStateFlow()
    private val admission = Mutex(); @Volatile private var epoch = 0L
    private val transport = WorkshopTransport(store, object : WorkshopPort {
        override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) = api.getWorkshop(path, emptyMap(), guard, retain)
        override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, refusal: (gg.pixelkingdomwars.nativeclient.network.ApiException) -> Unit) { api.postWorkshop(path, body, refusal, guard) }
    })
    init { check(store.identity.wallet == session.wallet && store.identity.origin == session.origin.toHttpUrl().toString().trimEnd('/')) }
    private fun current(e: Long) { holder.requireCurrent(session); check(epoch == e) { "The Workshop view closed. Check its saved receipt." } }
    private fun owned(base: String) {
        val dir = requireNotNull(directory()); check(dir.enabled && dir.stableMutations && dir.bases.any { it.id == base && it.selectable }) { "Select the original active kingdom." }
    }
    private fun selected(e: Long, base: String, g: Long, admit: Boolean = true) {
        current(e); check(selectedBase() == base && generation() == g) { "The selected kingdom changed. Review Workshop again." }
        if (admit) check(actionsAllowed()) { "Game orders are paused. Saved Workshop receipts remain available." }
    }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null, busy = false) } }
    /** Called on lifecycle or live content/interlock closure; never mutates durable evidence. */
    fun invalidateAdmission() = dismiss()
    private suspend fun <T> action(waitForIdle: Boolean = false, block: suspend (Long) -> T): T {
        holder.requireCurrent(session)
        if(waitForIdle)admission.lock() else check(admission.tryLock()) { "A Workshop request is already running." }
        val e = epoch
        try { holder.requireCurrent(session); mutable.update { it.copy(busy = true, journal = store.read()) }; return block(e) }
        finally {
            try { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false, journal = store.read(), review = if (epoch == e) it.review else null) } }
            finally { admission.unlock() }
        }
    }
    /** GET-only, independent of selected base and current new-command flags. */
    suspend fun check() = action { e -> transport.check { current(e) }; Unit }
    /** Wallet entry discovers capability without acquiring the active screen's money/review lock. */
    suspend fun discover() {
        val e=epoch; current(e)
        mutable.update { it.copy(advertised=false) }
        val cap=NativeCapabilities.from(api.get("/native/capabilities")).economy?.workshop; current(e)
        mutable.update { it.copy(advertised=cap?.enabled == true) }
    }
    /** Foreground refresh never starts or collects. Receipt recovery precedes optional discovery. */
    suspend fun refresh(waitForIdle: Boolean = false) = action(waitForIdle) { e ->
        mutable.update { it.copy(review=null,view=null,shards=null,advertised=false) }
        transport.check { current(e) }
        val cap = NativeCapabilities.from(api.get("/native/capabilities")).economy?.workshop; current(e)
        mutable.update { it.copy(advertised=cap?.enabled == true) }
        refreshAccount(); current(e)
        val base = selectedBase(); val g = generation()
        if (base != null && directory()?.let { it.enabled && it.stableMutations && it.bases.any { row -> row.id==base && row.selectable } } == true) {
            val (view,shards)=fresh(e,base,g,admit=false); selected(e,base,g,admit=false)
            mutable.update { it.copy(view=view,shards=shards) }
        }
    }
    private suspend fun fresh(e: Long, base: String, g: Long, admit: Boolean = true): Pair<WorkshopView, String> {
        val guard = { selected(e, base, g, admit) }
        guard(); refreshAccount(); guard(); owned(base)
        val view = WorkshopView.from(api.getWorkshop("/workshop", mapOf("baseId" to base), guard)); guard(); owned(base)
        check(view.inventory.baseId == base)
        val raw = api.get("/balances", mapOf("baseId" to base)); guard(); owned(base)
        val shards = raw.getValue("shards").jsonPrimitive
        require(shards.isString && shards.content.matches(Regex("0|[1-9][0-9]{0,18}")) && shards.content.toBigInteger() <= Long.MAX_VALUE.toBigInteger()) { "Invalid SHARDS balance" }
        return view to shards.content
    }
    private fun affordable(command: WorkshopCommand, view: WorkshopView, shards: String) {
        command.admit(view); if (command.kind == "start") check(command.charge().toBigInteger() <= shards.toBigInteger()) { "Not enough SHARDS for this refining job." }
    }
    private fun validClock(review: WorkshopReview) {
        val elapsedNow = elapsed(); val wallNow = wall()
        check(elapsedNow >= review.elapsed && wallNow >= review.wall) { "The clock changed. Review Workshop again." }
        val age = maxOf(Math.subtractExact(elapsedNow, review.elapsed), Math.subtractExact(wallNow, review.wall))
        if (review.command.kind == "start") check(Instant.parse(review.view.serverNow).plusMillis(age) < Instant.parse(review.view.allowance.resetsAt)) { "The UTC refining day changed. Review the original command again." }
    }
    private fun sameConsent(a: WorkshopView, b: WorkshopView, command: WorkshopCommand): Boolean = if (command.kind == "collect")
        a.jobs.single { it.jobId == command.jobId } == b.jobs.single { it.jobId == command.jobId }
        else a.level == b.level && a.recipeVersion == b.recipeVersion && a.shardsPerIngot == b.shardsPerIngot && a.batch == b.batch && a.secPerIngot == b.secPerIngot && a.allowance == b.allowance
    private suspend fun review(e: Long, original: WorkshopCommand?, create: ((WorkshopView) -> WorkshopCommand)?): Unit {
        mutable.update { it.copy(review = null) }
        val base = original?.baseId ?: requireNotNull(selectedBase()) { "Select an active kingdom." }; val g = generation()
        selected(e,base,g); val w = wall(); val m = elapsed(); val (view, shards) = fresh(e,base,g)
        val command = original ?: requireNotNull(create)(view); affordable(command,view,shards)
        val review = WorkshopReview(command,view,shards,e,g,w,m); validClock(review)
        val guard = { selected(e,base,g); validClock(review) }
        val saved = if (original == null) transport.begin(command,guard) else transport.check(guard)
        guard(); mutable.update { it.copy(journal = saved, view = view, shards = shards, review = if (saved.operation?.proof == null) review else null) }
    }
    suspend fun reviewStart(ingots: Long) = action { e -> check(store.read().operation == null); review(e,null) { WorkshopCommand.start(it,key(),ingots) } }
    suspend fun reviewCollect(jobId: String) = action { e -> check(store.read().operation == null); review(e,null) { WorkshopCommand.collect(it,key(),jobId) } }
    /** Explicit same-key re-review; historical receipt is observed before requiring original-base admission. */
    suspend fun reviewSaved() = action { e ->
        val saved = transport.check { current(e) }; val o = requireNotNull(saved.operation)
        check(o.refusal == null) { "Archive the original definitive refusal before a new command." }
        if (o.proof == null) review(e,o.command,null) else mutable.update { it.copy(review=null) }
    }
    suspend fun confirm(review: WorkshopReview) = action { e ->
        check(mutable.value.review === review && review.epoch == e)
        val guard = { current(e); check(mutable.value.review === review); selected(e,review.command.baseId,review.generation); validClock(review) }
        guard(); val expected = store.read(); check(expected.operation?.command == review.command)
        // If earlier acceptance is now visible, preserve it without requiring present-day terms.
        val observed = transport.check { current(e) }; if (observed.operation?.proof != null) { mutable.update { it.copy(review=null) }; return@action }
        check(observed.operation?.command == review.command)
        val (view,shards) = fresh(e,review.command.baseId,review.generation); guard()
        affordable(review.command,view,shards); check(sameConsent(review.view,view,review.command)) { "Workshop terms or allowance changed. Review the original command again." }
        try { transport.confirm(observed,guard) } finally { if (holder.isCurrent(session)) mutable.update { it.copy(review=null) } }
    }
    suspend fun archiveDraftOrRefusal() = action { e -> transport.archiveUnsentOrRefused(store.read()) { current(e) }; Unit }
    /** Explicit historical completion can archive a proven original receipt after a fresh directory
     * proves its destination unavailable. It never substitutes another base's current stock. */
    suspend fun finish() = action { e ->
        val expected = store.read(); val base = requireNotNull(expected.operation).command.baseId
        val guard = { current(e) }
        transport.finish(expected,guard) {
            refreshAccount(); guard(); val dir = requireNotNull(directory())
            check(dir.enabled && dir.stableMutations) { "Original base authority cannot be established yet." }
            if (selectedBase() != base || dir.bases.none { it.id == base && it.selectable }) {
                mutable.update { it.copy(view=null,shards=null,review=null,hydration=WorkshopHydration.ORIGINAL_BASE_UNAVAILABLE) }
            } else {
                val g = generation(); val selectedGuard = { selected(e,base,g,admit=false) }
                val (view,shards) = fresh(e,base,g,admit=false); selectedGuard(); owned(base)
                hydrateSelected(selectedGuard); selectedGuard(); refreshAccount(); selectedGuard(); owned(base)
                mutable.update { it.copy(view=view,shards=shards,review=null,hydration=WorkshopHydration.CURRENT_ORIGINAL_BASE) }
            }
        }; Unit
    }
}
