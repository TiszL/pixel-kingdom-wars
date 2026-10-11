package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import java.io.IOException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class WithdrawalUnwindReview(val action: WithdrawalUnwindAction, val target: WithdrawalUnwindTarget,
    val baseId: String?, val epoch: Long)
data class WithdrawalUnwindChoice(val target: WithdrawalUnwindTarget, val action: WithdrawalUnwindAction)
data class WithdrawalUnwindState(val pending: PendingIntent? = null, val busy: Boolean = false, val supported: Boolean = false,
    val choices: List<WithdrawalUnwindChoice> = emptyList(), val review: WithdrawalUnwindReview? = null,
    val outcome: WithdrawalUnwindOutcome? = null, val keepBalance: String? = null, val balanceUnavailable: Boolean = false,
    /** The saved key whose action offers CLOSE (owner review 2026-10-06: never sent, or a settled server `absent` answer;
     * `unknown` only stops it blocking). */
    val serverUnknownKey: String? = null)

/** Cancels/refunds only the caller's original escrow. No land, signing or fresh
 * request key is needed; all automatic recovery is an authenticated history GET. */
class WithdrawalUnwindRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, store: PendingIntentStore, private val observer: ReceiptObserver,
    private val selectedBaseId: () -> String?, private val directory: () -> BaseDirectory?,
    private val refreshAccount: suspend () -> Unit) {
    private val mutable = MutableStateFlow(WithdrawalUnwindState()); val state = mutable.asStateFlow()
    private val admission = Mutex(); private var epoch = 0L; private var actionEpoch: Long? = null
    private var actionBase: String? = null; private var requireSelection = false; private var permittedId: String? = null
    private suspend fun guard() {
        currentCoroutineContext().ensureActive(); holder.requireCurrent(session)
        check(actionEpoch == null || actionEpoch == epoch) { "The withdrawal view changed. Check the original saved request." }
        check(!requireSelection || actionBase == selectedBaseId()) { "The selected base changed. Review again." }
    }
    private suspend fun <T> bounded(read: suspend () -> T): T { guard(); return read().also { guard() } }
    fun dismiss() { epoch++; if (holder.isCurrent(session)) mutable.update { it.copy(review = null) } }
    private val op = MoneyOp(WithdrawalUnwindSpec, store, object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = bounded { api.get(path, query) }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            val saved = requireNotNull(store.get(IntentKind.WITHDRAWAL_UNWIND, session.wallet))
            WithdrawalUnwindSpec.consent(saved)
            check(actionEpoch != null && saved.idempotencyKey == permittedId && path == saved.path && body == saved.body) {
                "Open Withdrawals to explicitly confirm the original request."
            }; guard()
            val ack = bounded { api.post(path, body) }
            // A successful POST may already have compensated escrow. Any later
            // acknowledgement/history failure must keep the attempted request.
            return try {
                WithdrawalUnwindSpec.validateAcknowledgement(saved, ack)
                bounded { api.get("/withdrawals") }.also { raw ->
                    check(WithdrawalUnwindSpec.decodeReceipt(saved, raw) is Receipt.Accepted) { "The terminal withdrawal is not yet visible." }
                }
            } catch (error: kotlinx.coroutines.CancellationException) { throw error }
            catch (error: Exception) { throw IOException("Request sent. Check the original withdrawal status before trying again.", error) }
        }
    })
    init { observer.register(op, ::hydrate) }
    private suspend fun <T> action(selected: Boolean = false, block: suspend () -> T): T {
        holder.requireCurrent(session); check(admission.tryLock()) { "A withdrawal recovery action is already in progress." }
        actionEpoch = epoch; actionBase = selectedBaseId(); requireSelection = selected
        mutable.update { it.copy(busy = true) }
        try { guard(); return block() } finally {
            actionEpoch = null; permittedId = null; requireSelection = false
            try { if (holder.isCurrent(session)) { observer.refresh(session.wallet); holder.requireCurrent(session)
                mutable.update { it.copy(pending = op.pending(session.wallet), busy = false) } } } finally { admission.unlock() }
        }
    }
    private suspend fun history(): JsonObject {
        mutable.update { it.copy(supported = false, choices = emptyList()) }
        val raw = bounded { api.get("/withdrawals") }; val supported = WithdrawalUnwindSpec.supported(raw)
        val choices = if (!supported) emptyList() else requireNotNull(raw["withdrawals"] as? JsonArray).mapNotNull { value ->
            val row = value.jsonObject; val target = WithdrawalUnwindTarget.from(row)
            WithdrawalUnwindSpec.row(raw, target.id) // Duplicate IDs are not authoritative history.
            WithdrawalUnwindAction.entries.firstOrNull { WithdrawalUnwindSpec.eligible(row, it) }?.let { WithdrawalUnwindChoice(target, it) }
        }
        mutable.update { it.copy(supported = supported, choices = choices) }; return raw
    }
    suspend fun refresh() = action {
        val observed = op.observe(session.wallet, ::hydrate)
        mutable.update { it.copy(serverUnknownKey = op.pending(session.wallet)?.idempotencyKey?.takeIf { observed != null && op.closable(session.wallet) }) }
        history(); Unit
    }
    /** The saved action's CLOSE (owner 2026-10-06): the existing MoneyOp closure. It reads the history once more; a terminal
     * row found there is hydrated as usual, and only a settled server `absent` answer for this exact key archives it on this device (re-read on every Home resume). No POST. */
    suspend fun close(): Receipt<*>? = action {
        op.close(session.wallet, confirmed = true, ::hydrate).also { mutable.update { state -> state.copy(serverUnknownKey = null) } }
    }
    suspend fun review(id: String, requested: WithdrawalUnwindAction) = action(selected = true) {
        check(op.blocking(session.wallet) == null) { "Check the original interrupted withdrawal action first." }
        val raw = history(); check(mutable.value.supported) { "Withdrawal recovery needs an available server update." }
        val row = requireNotNull(WithdrawalUnwindSpec.row(raw, id)) { "Refresh this original withdrawal before continuing." }
        check(WithdrawalUnwindSpec.eligible(row, requested)) { "The server no longer permits this withdrawal action." }
        mutable.update { it.copy(review = WithdrawalUnwindReview(requested, WithdrawalUnwindTarget.from(row), selectedBaseId(), epoch)) }
    }
    suspend fun confirm(review: WithdrawalUnwindReview) = action(selected = true) {
        check(mutable.value.review == review && review.epoch == epoch && review.baseId == selectedBaseId()) { "Review the original withdrawal again." }
        check(op.blocking(session.wallet) == null) { "Check the saved withdrawal action first." }
        val raw = history(); check(mutable.value.supported)
        val row = requireNotNull(WithdrawalUnwindSpec.row(raw, review.target.id))
        require(WithdrawalUnwindTarget.from(row) == review.target) { "The original withdrawal details changed." }
        check(WithdrawalUnwindSpec.eligible(row, review.action)) { "The server no longer permits this withdrawal action." }
        val intent = WithdrawalUnwindSpec.intent(session.wallet, review.baseId, review.action, review.target)
        // The key is derived from the row and action, so a new request can reuse a closed one's key: never its old answer.
        permittedId = intent.idempotencyKey; mutable.update { it.copy(review = null, serverUnknownKey = null) }; op.submit(intent, ::hydrate); history(); Unit
    }
    suspend fun retry() = action(selected = true) {
        val saved = requireNotNull(op.pending(session.wallet)); val (requested, target) = WithdrawalUnwindSpec.consent(saved)
        val observed = op.observe(session.wallet, ::hydrate)
        if (observed != Receipt.Unknown && observed != Receipt.Absent) return@action
        val raw = history(); check(mutable.value.supported) { "Keep the original request saved until history is available." }
        val row = requireNotNull(WithdrawalUnwindSpec.row(raw, target.id)) { "Missing withdrawal history does not prove failure." }
        require(WithdrawalUnwindTarget.from(row) == target)
        check(WithdrawalUnwindSpec.eligible(row, requested)) { "The server does not currently allow the original action. Keep checking its status." }
        permittedId = saved.idempotencyKey; op.retry(session.wallet, ::hydrate); history(); Unit
    }
    private suspend fun hydrate(accepted: Receipt.Accepted<WithdrawalUnwindOutcome>) {
        guard(); val proof = accepted.value; bounded { refreshAccount() }
        val dir = requireNotNull(directory()) { "Refresh the original account directory before finishing recovery." }
        val unavailable = if (proof.baseId == null) dir.enabled else !dir.enabled || dir.bases.none { it.id == proof.baseId && it.selectable }
        val keep = if (unavailable) null else {
            val raw = bounded { api.get("/balances", proof.baseId?.let { mapOf("baseId" to it) }.orEmpty()) }
            val amount = requireNotNull((raw["keep"] as? JsonPrimitive)?.takeIf { it.isString }?.content)
            require(amount.matches(Regex("0|[1-9][0-9]{0,18}")) && amount.toLong() >= 0); amount
        }
        check(directory() == dir) { "The original balance scope changed. Check the saved withdrawal again." }
        guard(); mutable.update { it.copy(outcome = proof, keepBalance = keep, balanceUnavailable = unavailable) }
    }
}
