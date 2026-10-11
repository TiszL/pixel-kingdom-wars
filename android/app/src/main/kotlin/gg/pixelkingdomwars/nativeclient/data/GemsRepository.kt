package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.util.UUID

data class GemsReview(val intent: PendingIntent, val rate: Long?, val output: String, val generation: Long, val epoch: Long)
data class GemsState(val supported: Boolean = false, val enabled: Boolean = false, val busy: Boolean = false,
    val overview: GemsOverview? = null, val balances: Balances? = null, val review: GemsReview? = null,
    val pending: List<PendingIntent> = emptyList(), val receipt: GemsAcceptance? = null, val unavailable: String? = null,
    /** Per kind, the saved key whose SAVED card offers CLOSE (owner review 2026-10-06: never sent, or a settled server
     * `absent` answer; `unknown` only stops it blocking). */
    val serverUnknownKeys: Map<String, String> = emptyMap())

/** Ledger-only Gems. The AppGraph owns this family's origin/cluster store across sessions;
 * this repository and its transport stay bound to one immutable authenticated session. */
class GemsRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: PendingIntentStore, private val observer: ReceiptObserver,
    private val selectedBaseId: () -> String?, private val selectionGeneration: () -> Long,
    private val directory: () -> BaseDirectory?, private val refreshAccount: suspend () -> Unit,
    private val refreshSelected: suspend () -> Unit) {
    private val mutable = MutableStateFlow(GemsState()); val state = mutable.asStateFlow()
    private val admission = Mutex(); @Volatile private var epoch = 0L; @Volatile private var actionEpoch: Long? = null
    @Volatile private var generation: Long? = null; private var permitted: PendingIntent? = null
    private val specs = listOf(GemsFromKeepSpec, GemsToShardsSpec, GemsTaskClaimSpec)
    private suspend fun guard() { currentCoroutineContext().ensureActive(); current() }
    private fun current() {
        holder.requireCurrent(session)
        check(actionEpoch == null || actionEpoch == epoch) { "The Gems review closed. Check the saved request." }
        check(generation == null || generation == selectionGeneration()) { "The selected base changed. Review Gems again." }
    }
    private suspend fun <T> bounded(block: suspend () -> T): T { guard(); return block().also { guard() } }
    private val transport = object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = bounded { api.get(path, query) }
        override suspend fun postObserved(intent: PendingIntent, refusal: (gg.pixelkingdomwars.nativeclient.network.ApiException) -> Unit): JsonObject {
            val original = requireNotNull(permitted) { "Review the original Gems request first." }
            check(actionEpoch != null && original.nextAttempt() == intent)
            return bounded { api.postMoneyCommand(intent.path, intent.body, null, refusal, ::current) }
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            val original = requireNotNull(permitted) { "Review the original Gems request first." }
            check(actionEpoch != null && original.path == path && original.body == body)
            return bounded { api.post(path, body) }
        }
    }
    private val operations = specs.associate { it.kind to MoneyOp(it, store, it.verifiedTransport(transport)) }
    init {
        // Local evidence is visible even if the network or new-operation flag is off.
        mutable.update { it.copy(pending = saved()) }
        operations.values.forEach { observer.register(it, ::hydrate) }
    }
    private fun saved() = store.all(session.wallet).also { entries ->
        require(entries.all { it.kind in operations }) { "Unsupported saved Gems operation. Keep this recovery record." }
    }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    private suspend fun <T> action(selected: Boolean = false, block: suspend () -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "A Gems request is already being checked." }
        actionEpoch = epoch; generation = if (selected) selectionGeneration() else null
        try {
            mutable.update { it.copy(busy = true, enabled = false, pending = saved()) }
            guard(); return block()
        }
        finally {
            permitted = null; actionEpoch = null; generation = null
            try { if (holder.isCurrent(session)) { observer.refresh(session.wallet); holder.requireCurrent(session)
                mutable.update { it.copy(busy = false, pending = saved()) } } } finally { admission.unlock() }
        }
    }
    private suspend fun probe(): GemsOverview {
        mutable.update { it.copy(enabled = false, supported = false) }
        val capability = NativeCapabilities.from(bounded { api.get("/native/capabilities") }).economy?.gems
        check(capability?.enabled == true) { "Gems are unavailable. Saved receipts can still be checked." }
        val overview = GemsOverview.from(bounded { api.get("/gems") })
        check(overview.features.gems?.supported == true) { "This server needs a compatible Gems client." }
        check(capability.exactConsent == 1 && overview.features.gems?.exactConsent == 1) {
            "This server cannot guarantee the reviewed Gems output. Saved receipts can still be checked."
        }
        check(capability.gemsPerKeep == overview.gemsPerKeep && capability.shardsPerGem == overview.shardsPerGem
            && capability.minConvertKeep == overview.minConvertKeep && capability.maxConvertKeepPerTx == overview.maxConvertKeepPerTx
            && overview.sources.all { it in capability.sources }) { "Gems terms changed while refreshing. Try again." }
        mutable.update { it.copy(supported = true, enabled = true, overview = overview) }; return overview
    }
    private fun originalAvailable(base: String?): Boolean {
        val dir = requireNotNull(directory()) { "Refresh your base directory first." }
        return if (base == null) !dir.enabled else dir.enabled && dir.stableMutations && dir.bases.any { it.id == base && it.selectable }
    }
    private fun validate(intent: PendingIntent, overview: GemsOverview) {
        operations.getValue(intent.kind).spec.validateSend(intent)
        when (intent.kind) {
            IntentKind.GEMS_FROM_KEEP -> {
                check("ledger-keep" in overview.sources) { "Custodial KEEP conversion is unavailable." }
                val value = intent.body.getValue("keep").jsonPrimitive.content.toBigInteger()
                require(value >= overview.minConvertKeep.toBigInteger() && value <= overview.maxConvertKeepPerTx.toBigInteger()) { "The amount is outside the server conversion bounds." }
            }
            IntentKind.GEMS_TO_SHARDS -> {
                check(originalAvailable(intent.baseId) && intent.baseId == selectedBaseId()) { "Select the original active base before converting Gems to SHARDS." }
                check(intent.body.getValue("gems").jsonPrimitive.content.toBigInteger() <= overview.gems.toBigInteger()) { "Not enough Gems." }
            }
            IntentKind.GEMS_TASK_CLAIM -> check(overview.tasks.any { it.id == intent.quote?.get("taskId")?.jsonPrimitive?.content && !it.claimed }) { "This Gems task is unavailable or already claimed." }
        }
    }
    private fun terms(intent: PendingIntent, overview: GemsOverview): Pair<Long?, String> = when (intent.kind) {
        IntentKind.GEMS_FROM_KEEP -> overview.gemsPerKeep.let { it to (intent.body.getValue("keep").jsonPrimitive.content.toBigInteger() * it.toBigInteger()).toString() }
        IntentKind.GEMS_TO_SHARDS -> overview.shardsPerGem.let { it to (intent.body.getValue("gems").jsonPrimitive.content.toBigInteger() * it.toBigInteger()).toString() }
        else -> null to overview.tasks.single { it.id == intent.quote?.get("taskId")?.jsonPrimitive?.content }.gems
    }
    /** GET-only observation of one kind's saved request; remembers the saved key its card may close ([MoneyOp.closable]). */
    private suspend fun observe(kind: String): Receipt<GemsAcceptance>? {
        val op = operations.getValue(kind)
        val observed = op.observe(session.wallet, ::hydrate)
        val unknownKey = op.pending(session.wallet)?.idempotencyKey?.takeIf { observed != null && op.closable(session.wallet) }
        mutable.update { state -> state.copy(serverUnknownKeys = unknownKey?.let { state.serverUnknownKeys + (kind to it) } ?: (state.serverUnknownKeys - kind)) }
        return observed
    }
    suspend fun refresh() = action {
        operations.keys.forEach { observe(it) }
        bounded { refreshAccount() }; probe()
        val base = selectedBaseId(); if (originalAvailable(base)) {
            val generation = selectionGeneration(); val balances = loadBalances(base)
            if (base == selectedBaseId() && generation == selectionGeneration()) mutable.update { it.copy(balances = balances) }
        }
        Unit
    }
    suspend fun review(kind: String, amount: String? = null, taskId: String? = null) = action(selected = true) {
        // Owner review 2026-10-06: a saved request that no longer blocks (settled and checked) stays shown but never shuts Gems.
        check(saved().isEmpty() || operations.values.none { it.blocking(session.wallet) != null }) { "Check the original saved Gems request before starting another." }
        mutable.update { it.copy(review = null) }; bounded { refreshAccount() }; val overview = probe()
        val key = UUID.randomUUID().toString()
        val intent = when (kind) {
            IntentKind.GEMS_FROM_KEEP -> GemsFromKeepSpec.intent(session.wallet, key, requireNotNull(amount))
            IntentKind.GEMS_TO_SHARDS -> GemsToShardsSpec.intent(session.wallet, selectedBaseId(), key, requireNotNull(amount))
            IntentKind.GEMS_TASK_CLAIM -> GemsTaskClaimSpec.intent(session.wallet, requireNotNull(taskId), key)
            else -> error("Unsupported Gems action")
        }
        validate(intent, overview); val (rate, output) = terms(intent, overview)
        val expected = buildJsonObject { put("rate", rate?.let(::JsonPrimitive) ?: JsonNull); put("output", output) }
        val consent = intent.copy(body = JsonObject(intent.body + ("expected" to expected)), quote = buildJsonObject {
            intent.quote?.forEach { (key, value) -> put(key, value) }
            put("gemsConsentVersion", 1); put("rate", rate?.let(::JsonPrimitive) ?: JsonNull); put("output", output)
        })
        mutable.update { it.copy(review = GemsReview(consent, rate, output, selectionGeneration(), epoch), receipt = null, unavailable = null) }
    }
    suspend fun confirm(review: GemsReview) = action(selected = true) {
        require(mutable.value.review == review && review.epoch == epoch && review.generation == selectionGeneration()) { "Review Gems again after the account or base changed." }
        check(saved().isEmpty() || operations.values.none { it.blocking(session.wallet) != null }) { "Check the original saved Gems request first." }
        bounded { refreshAccount() }; val overview = probe(); validate(review.intent, overview)
        require(terms(review.intent, overview) == (review.rate to review.output)) { "Gems terms changed. Review the new amount first." }
        permitted = review.intent; mutable.update { it.copy(review = null) }
        operations.getValue(review.intent.kind).submit(review.intent, ::hydrate); Unit
    }
    suspend fun check(kind: String): Receipt<GemsAcceptance>? = action { observe(kind) }
    /** The SAVED card's CLOSE (owner 2026-10-06): the existing MoneyOp closure. It reads the receipt once more; an acceptance
     * found there is hydrated as usual, and only a settled server `absent` answer for this exact key archives it on this device (re-read on every Home resume). No POST. */
    suspend fun close(kind: String): Receipt<GemsAcceptance>? = action {
        operations.getValue(kind).close(session.wallet, confirmed = true, ::hydrate)
            .also { mutable.update { state -> state.copy(serverUnknownKeys = state.serverUnknownKeys - kind) } }
    }
    suspend fun retry(kind: String) = action(selected = true) {
        val op = operations.getValue(kind); val original = requireNotNull(op.pending(session.wallet))
        if (op.observe(session.wallet, ::hydrate).let { it != Receipt.Unknown && it != Receipt.Absent }) return@action
        bounded { refreshAccount() }; val overview = probe(); validate(original, overview)
        val (rate, output) = terms(original, overview)
        val quote = original.quote
        check(quote?.get("gemsConsentVersion") == JsonPrimitive(1)
            && quote["rate"] == (rate?.let(::JsonPrimitive) ?: JsonNull)
            && quote["output"] == JsonPrimitive(output)
            && original.body["expected"] == buildJsonObject { put("rate", rate?.let(::JsonPrimitive) ?: JsonNull); put("output", output) }) {
            "The saved Gems terms differ from this server. Keep checking the original receipt; no new request was sent."
        }
        permitted = original; op.retry(session.wallet, ::hydrate); Unit
    }
    private suspend fun loadBalances(base: String?): Balances {
        val balances = Balances.from(bounded { api.get("/balances", base?.let { mapOf("baseId" to it) }.orEmpty()) })
        ForgeClaimContract.amount(balances.keep); ForgeClaimContract.amount(balances.shards); balances.gems?.let(ForgeClaimContract::amount)
        return balances
    }
    private suspend fun hydrate(accepted: Receipt.Accepted<GemsAcceptance>) {
        guard(); bounded { refreshAccount() }; val dir = requireNotNull(directory())
        val base = if (accepted.value.kind == IntentKind.GEMS_TO_SHARDS) accepted.value.baseId else selectedBaseId()
        val unavailable = if (originalAvailable(base)) null else "The original balance destination is unavailable. This receipt proves the original credit, not current base stock."
        if (unavailable == null) {
            val selection = selectionGeneration(); val balances = loadBalances(base); bounded { refreshAccount() }
            require(directory() == dir) { "The original destination changed during refresh. Check its receipt again." }
            if (base == selectedBaseId() && selection == selectionGeneration()) {
                bounded { refreshSelected() }
                if (base == selectedBaseId() && selection == selectionGeneration()) mutable.update { it.copy(balances = balances) }
            }
        }
        guard(); mutable.update { it.copy(receipt = accepted.value, unavailable = unavailable) }
    }
}
