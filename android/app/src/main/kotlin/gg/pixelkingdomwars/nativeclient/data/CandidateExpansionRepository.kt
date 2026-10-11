package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.*
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class CandidateExpansionUiState(val loaded: Boolean = false, val busy: Boolean = false, val available: Boolean = false,
    val saved: SavedCandidateExpansion? = null, val hydrated: Boolean = false, val error: String? = null, val refreshError: String? = null)

class CandidateExpansionRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: CandidateExpansionStore, private val enabled: Boolean,
    private val selectedBaseId: () -> String?, private val directory: () -> BaseDirectory?,
    private val catalogue: () -> JsonObject?, private val actionsAllowed: () -> Boolean,
    private val refreshAccount: suspend () -> Unit, private val refreshSelected: suspend () -> Unit) {
    private val mutable = MutableStateFlow(CandidateExpansionUiState()); val state = mutable.asStateFlow()
    private val admission = Mutex()
    @Volatile private var epoch = 0L
    private var actionEpoch = 0L
    private var original: String? = null; private var mutation = false
    fun dismiss() { epoch++ }
    private suspend fun guard() {
        currentCoroutineContext().ensureActive(); holder.requireCurrent(session)
        require(enabled && session.origin == CandidateExpansionContract.ORIGIN) { "Test expansions are unavailable in this app." }
        check(actionEpoch == epoch) { "This review closed. The original request is saved." }
        if (mutation) require(original == selectedBaseId() && actionsAllowed()) { "The selected base changed. Check the original request." }
    }
    private suspend fun <T> disk(block: () -> T): T = withContext(Dispatchers.IO) {
        guard(); store.access({ holder.requireCurrent(session) }, block).also { guard() }
    }
    private suspend fun <T> request(block: suspend () -> T): T {
        guard()
        val timeout = requireNotNull(((catalogue()?.get("constants") as? JsonObject)?.get("LAND_CHECKOUT_RECOVERY") as? JsonObject)?.string("requestTimeoutMs")).toLong()
        require(timeout > 0)
        return try { withTimeout(timeout) { block() }.also { guard() } }
        catch (_: TimeoutCancellationException) { throw java.io.IOException("Connection interrupted. Check your saved test expansion.") }
    }
    private suspend fun publish() { val saved = disk(store::read); mutable.update { it.copy(loaded = true, saved = saved,
        hydrated = it.hydrated && it.saved?.state?.receipt == saved?.state?.receipt && saved?.state?.receipt != null) } }
    private suspend fun action(changesBase: Boolean = false, block: suspend () -> Unit) {
        if (!admission.tryLock()) return
        mutation = changesBase; original = selectedBaseId(); actionEpoch = epoch
        try { guard(); mutable.update { it.copy(busy = true, error = null, available = false) }; block() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { holder.requireCurrent(session); mutable.update { it.copy(error = e.message ?: "Check the saved expansion.") } }
        finally {
            try { if (holder.isCurrent(session)) {
                try { publish() } catch (_: Exception) { mutable.update { it.copy(loaded = false, available = false) } }
                mutable.update { it.copy(busy = false) }
            } } finally { mutation = false; admission.unlock() }
        }
    }
    private fun requireOriginal(baseId: String, quote: CandidateExpansionQuote? = null) {
        require(selectedBaseId() == baseId && actionsAllowed()) { "Select the original test base before confirming." }
        val dir = requireNotNull(directory()); require(dir.stableMutations)
        val base = dir.bases.single { it.id == baseId && it.selectable }
        require(base.deedAssetId == null && base.landPaidAt != null)
        if (quote != null) require(base.landPaidAt == quote.landPaidAt) { "The original test base changed." }
    }
    private suspend fun capability(baseId: String): String {
        val source = CandidateExpansionContract.capability(request { api.get("$PATH/capability", mapOf("baseId" to baseId)) }, session.wallet, baseId)
        mutable.update { it.copy(available = true) }; return source
    }
    private suspend fun adopt(raw: JsonObject): CandidateExpansionState {
        val value = CandidateExpansionState.from(raw); require(value.wallet == session.wallet)
        disk { store.adopt(value) }; publish(); return value
    }
    private suspend fun observe(): CandidateExpansionState? {
        val saved = disk(store::read) ?: return null
        if (saved.state?.status == "granted") { hydrate(saved.state); return saved.state }
        val value = adopt(request { api.get("$PATH/${saved.request.key}") })
        if (value.status == "granted") hydrate(value)
        return value
    }
    private suspend fun hydrate(value: CandidateExpansionState) {
        require(value.status == "granted"); mutable.update { it.copy(refreshError = null) }
        try {
            request { refreshAccount() }
            val quote = requireNotNull(value.quote); val baseId = quote.request.baseId
            val dir = requireNotNull(directory())
            val owned = dir.bases.firstOrNull { it.id == baseId && it.selectable }
            if (owned != null && owned.landPaidAt == quote.landPaidAt && owned.deedAssetId == null) {
                val home = request { readHome(api, baseId) }
                val claim = requireNotNull(home.base.claim)
                require(home.base.baseId == baseId && requireNotNull(home.base.player.expansions) >= BasePurchaseContract.integer(requireNotNull(value.receipt), "toExpansions")
                    && claim.max.toLong() - claim.min >= quote.toTiles) { "Your new claim is still updating. Check again." }
                if (selectedBaseId() == baseId) request { refreshSelected() }
            } else {
                mutable.update { it.copy(refreshError = "This receipt belongs to your original test base, which is no longer available. Your selected base is unchanged.") }
            }
            guard(); mutable.update { it.copy(hydrated = true) }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { guard(); mutable.update { it.copy(refreshError = "Expansion complete. ${e.message ?: "Refresh your base to see the new claim."}") } }
    }
    suspend fun open(baseId: String) = action { publish(); if (disk(store::read) != null) observe() else capability(baseId) }
    suspend fun check() = action { observe() }
    suspend fun create(baseId: String) = action(true) {
        check(disk(store::read) == null); request { refreshAccount() }; requireOriginal(baseId); capability(baseId)
        val home = request { readHome(api, baseId) }; require(home.base.baseId == baseId)
        val raw = buildJsonObject { put("kind", "expansion"); put("idempotencyKey", UUID.randomUUID().toString())
            put("baseId", baseId); put("expectedExpansions", requireNotNull(home.base.player.expansions)) }
        val draft = BasePurchaseRequest.from(raw); disk { store.draft(draft) }; publish(); quote(draft)
    }
    private suspend fun quote(draft: BasePurchaseRequest) { adopt(request { api.post("$PATH/quote", draft.raw) }) }
    suspend fun retryQuote() = action(true) {
        val saved = requireNotNull(disk(store::read)); val observed = observe()
        if (observed?.status != "unquoted") return@action
        request { refreshAccount() }; requireOriginal(saved.request.baseId); capability(saved.request.baseId); quote(saved.request)
    }
    suspend fun confirm() = action(true) {
        val before = requireNotNull(disk(store::read)); val reviewed = requireNotNull(before.state?.quote)
        require(before.state.status == "quoted"); val observed = observe()
        if (observed?.status != "quoted") return@action
        require(observed.quote == reviewed); request { refreshAccount() }; requireOriginal(reviewed.request.baseId, reviewed)
        require(capability(reviewed.request.baseId) == reviewed.sourceSha) { "The test build changed. Cancel this original request before reviewing again." }
        disk { store.confirm(reviewed.hash) }; publish()
        val result = adopt(request { api.post("$PATH/${reviewed.request.key}/confirm", jsonBody("quoteHash" to reviewed.hash)) })
        if (result.status == "granted") hydrate(result)
    }
    suspend fun cancel() = action {
        val saved = requireNotNull(disk(store::read))
        val result = adopt(request { api.post("$PATH/${saved.request.key}/cancel") })
        if (result.status == "granted") hydrate(result)
    }
    suspend fun finish() = action {
        val saved = disk(store::read)
        if (saved != null && saved.state?.status != "cancelled" && saved.state?.status != "granted") {
            // Dead-end audit 2026-10-06 (shape A): a request the server holds no quote for can be finished only when
            // this same action's by-key GET answered `unquoted` for exactly its key and no consent was saved.
            check(saved.confirmedHash == null) { "An original confirmation is saved. Check its outcome first." }
            val observed = checkNotNull(observe()) { "The saved request is unavailable." }
            check(observed.status == "unquoted" && observed.key == saved.request.key) { "The server has a quote for this request. Review or cancel it." }
            disk { store.finishUnquoted(observed) }; publish(); return@action
        }
        disk { store.finish(mutable.value.hydrated) }; publish()
    }
    companion object { const val PATH = "/candidate/expansions/v1" }
}
