package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.Identity
import gg.pixelkingdomwars.nativeclient.model.LandDeposit
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.network.jsonBody
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Web `EntryPhase`: the checkout is one state machine per wallet and purchase kind. */
enum class LandPhase { IDLE, RESTORING, RESERVING, READY, PAYING, CONFIRMING, CREDITED, FAILED }

/** Client recovery bounds, read only from the catalogue's `constants.LAND_CHECKOUT_RECOVERY`
 * (`packages/shared/src/constants.ts`); they bound waiting for responses, never the server's payment
 * window. A pack without the block, or with any timer missing or non-positive, yields null and the
 * checkout fails closed — there is no Kotlin copy of these numbers. */
data class LandCheckoutBounds(val requestTimeoutMs: Long, val walletResponseGraceMs: Long, val firstEntryRetryMs: Long, val pollMs: Long) {
    init { require(requestTimeoutMs > 0 && walletResponseGraceMs > 0 && firstEntryRetryMs > 0 && pollMs > 0) }
    companion object {
        fun from(catalogue: JsonObject?): LandCheckoutBounds? {
            val c = (catalogue?.get("constants") as? JsonObject)?.get("LAND_CHECKOUT_RECOVERY") as? JsonObject ?: return null
            fun read(key: String) = c.string(key)?.toLongOrNull()?.takeIf { it > 0 }
            return LandCheckoutBounds(read("requestTimeoutMs") ?: return null, read("walletResponseGraceMs") ?: return null,
                read("firstEntryRetryMs") ?: return null, read("pollMs") ?: return null)
        }
    }
}

/** The durable recovery hint (web `SavedPurchase`): which deposit this wallet is paying, whether a
 * wallet request was started and the server-clock instant it started, and the signature once known.
 * Never a balance; the server row is re-read before every decision. */
@Serializable data class SavedLandPurchase(val id: String, val signature: String? = null, val submitted: Boolean = false, val attemptStartedAt: Long? = null)

class LandPurchaseStore(private val store: SecretStore) {
    private fun all(): Map<String, SavedLandPurchase> = store.read()?.let { text ->
        Json.parseToJsonElement(text).jsonObject.mapValues { Json.decodeFromJsonElement<SavedLandPurchase>(it.value) }
    }.orEmpty()
    private fun write(values: Map<String, SavedLandPurchase>) {
        if (values.isEmpty()) store.clear() else store.write(JsonObject(values.mapValues { Json.encodeToJsonElement(it.value) }).toString())
    }
    @Synchronized fun read(key: String): SavedLandPurchase? = all()[key]
    @Synchronized fun save(key: String, value: SavedLandPurchase?) { write(if (value == null) all() - key else all() + (key to value)) }
    /** Late callbacks may update only the intent they originally submitted. */
    @Synchronized fun saveMatching(key: String, id: String, value: SavedLandPurchase?) { if (read(key)?.id == id) save(key, value) }
    companion object { fun key(cluster: SolanaCluster, wallet: String, kind: String) = "${cluster.id}:$wallet:$kind" }
}

/** Signs and broadcasts one reviewed land transaction, returning its 64-byte signature. A signer that
 * broadcasts itself (the sign-only relay fallback) calls [recordSignature] with the signature strictly
 * before its single RPC send, so a lost reply still leaves a durable payment identity to verify. */
fun interface LandSigner { suspend fun signAndSend(transaction: ByteArray, cluster: SolanaCluster, wallet: String, recordSignature: (ByteArray) -> Unit): ByteArray }

data class LandCheckoutState(
    val phase: LandPhase = LandPhase.IDLE,
    val purchaseKind: String = "entry",
    val cluster: SolanaCluster = SolanaCluster.DEVNET,
    /** A tile chosen on the picker but not yet reserved (web `landPurchase.landAddress`). */
    val draftedTile: Int? = null,
    val reservation: LandDeposit? = null,
    val paymentSignature: String? = null,
    val estimate: LandFundingEstimate? = null,
    val estimateUnavailable: Boolean = false,
    val estimateLoading: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    /** Set when the loaded catalogue lacks `LAND_CHECKOUT_RECOVERY`: no reservation, payment or restore runs. */
    val unavailable: String? = null,
    /** Server clock anchor of [reservation]: `serverNow` and the monotonic instant it was observed. */
    val serverNowMs: Long? = null,
    val observedAtMs: Long? = null,
    /** Server-clock instant the last wallet request started (first-land retry window). */
    val attemptStartedAtMs: Long? = null,
    val retrying: Boolean = false,
) {
    val busy: Boolean get() = phase == LandPhase.RESERVING || phase == LandPhase.PAYING || phase == LandPhase.RESTORING
    /** Server time now, projected from the anchor; null until a reservation with `serverNow` arrived. */
    fun serverTime(nowMs: Long): Long? = serverNowMs?.let { anchor -> observedAtMs?.let { anchor + maxOf(0L, nowMs - it) } }
    private fun parse(text: String?): Long? = text?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    fun payableRemainingSec(nowMs: Long): Long? { val until = parse(reservation?.payableUntil) ?: return null; val now = serverTime(nowMs) ?: return null; return maxOf(0L, (until - now + 999) / 1000) }
    fun reservationRetryInSec(nowMs: Long): Long? { val at = parse(reservation?.retryAt) ?: return null; val now = serverTime(nowMs) ?: return null; return maxOf(0L, (at - now + 999) / 1000) }
    fun retryEntryInSec(nowMs: Long, bounds: LandCheckoutBounds): Long? {
        if (purchaseKind != "entry") return null
        val started = attemptStartedAtMs ?: return null; val now = serverTime(nowMs) ?: return null
        return maxOf(0L, (started + bounds.firstEntryRetryMs - now + 999) / 1000)
    }
    fun canRetryEntry(nowMs: Long, bounds: LandCheckoutBounds): Boolean {
        val until = parse(reservation?.payableUntil) ?: return false; val now = serverTime(nowMs) ?: return false
        return purchaseKind == "entry" && phase == LandPhase.CONFIRMING && !retrying && reservation != null && retryEntryInSec(nowMs, bounds) == 0L && now < until
    }
}

interface LandRepository {
    val state: StateFlow<LandCheckoutState>
    val reservation: MoneyOp<LandReservationAcceptance>
    /** Opens the checkout for [kind]: restores a saved purchase, or keeps a live one for the same kind. */
    suspend fun open(kind: String)
    fun draft(tileId: Int?)
    suspend fun reserve(tileId: Int?)
    suspend fun pay(signer: LandSigner)
    suspend fun retryPayment(signer: LandSigner)
    suspend fun refreshEstimate()
    fun clearNotice()
}

/** Land checkout (web `auth/useEntry.ts` + `landPayment.ts`): freeze the parcel through the one money
 * mechanism, price the payment from RPC, obtain the wallet's signature once, then reconcile that same
 * intent by reference across restarts. Every decision re-reads `/me` and the deposit row first. */
class LiveLandRepository(
    private val session: AccountSession,
    private val holder: AccountSessionHolder,
    private val scope: CoroutineScope,
    private val api: ApiClient,
    intents: PendingIntentStore,
    private val observer: ReceiptObserver,
    private val purchases: LandPurchaseStore,
    private val cluster: SolanaCluster,
    private val rpc: (SolanaCluster) -> SolanaRpc,
    private val addresses: (SolanaCluster) -> ChainAddresses,
    /** The catalogue's `LAND_CHECKOUT_RECOVERY`, or null while the loaded pack lacks it. */
    private val catalogueBounds: () -> LandCheckoutBounds?,
    private val now: () -> Long,
    private val newKey: () -> String = { UUID.randomUUID().toString() },
) : LandRepository {
    private val _state = MutableStateFlow(LandCheckoutState(cluster = cluster))
    override val state: StateFlow<LandCheckoutState> = _state.asStateFlow()
    override val reservation = MoneyOp(LandReservationSpec, intents, api.asTransport())
    private var poll: Job? = null
    private var grace: Job? = null
    private var restoreRetry: Job? = null
    private var estimateJob: Job? = null
    private var estimateSequence = 0
    private var terminalIntent: String? = null
    /** Volatile: the payment's signature journal reads it from inside the wallet association, on the wallet library's thread. */
    @Volatile private var attemptSequence = 0
    private var pollSequence = 0
    /** Snapshot of the catalogue bounds taken by [open]; every timer and timeout reads it. Null = fail closed. */
    private var activeBounds: LandCheckoutBounds? = null
    init { observer.register(reservation) { accepted -> adoptAccepted(accepted.value, state.value.purchaseKind) } }

    private val wallet get() = session.wallet
    private fun bounds(): LandCheckoutBounds = activeBounds ?: throw IllegalStateException(LAND_CHECKOUT_UNAVAILABLE)
    private fun key(kind: String) = LandPurchaseStore.key(cluster, wallet, kind)
    private fun setPhase(phase: LandPhase) = _state.update { it.copy(phase = phase) }
    private fun fail(message: String?) = _state.update { it.copy(error = message) }
    private suspend fun <T> bounded(block: suspend () -> T): T = try { withTimeout(bounds().requestTimeoutMs) { block() } }
        catch (error: TimeoutCancellationException) { throw IOException("Land status request timed out", error) }
    private fun stopPolling() { pollSequence++; poll?.cancel(); poll = null }
    private fun clearGrace() { grace?.cancel(); grace = null }
    private fun serverMs(text: String?): Long? = text?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
    private suspend fun me(): Identity = Identity.from(bounded { api.get("/me") }).also { require(it.wallet == wallet) { "Wallet session changed" } }
    private suspend fun row(id: String): LandDeposit = LandDeposit.from(bounded { api.get("/deposits/$id") })

    override fun draft(tileId: Int?) { _state.update { it.copy(draftedTile = tileId?.takeIf { t -> t >= 0 }, error = null) } }
    override fun clearNotice() { _state.update { it.copy(error = null, notice = null) } }

    override suspend fun open(kind: String) {
        require(kind == "entry" || kind == "deed")
        holder.requireCurrent(session)
        val current = _state.value
        if (current.purchaseKind == kind && (current.phase != LandPhase.IDLE || current.draftedTile != null)) {
            refreshEstimate()
            return
        }
        stopPolling(); clearGrace(); restoreRetry?.cancel(); cancelEstimate()
        terminalIntent = null; attemptSequence++
        // Fail closed: without the catalogue's recovery bounds nothing is timed, polled or signed. The
        // durable purchase marker stays untouched for the next open after a content update.
        activeBounds = catalogueBounds()
        if (activeBounds == null) { _state.value = LandCheckoutState(purchaseKind = kind, cluster = cluster, unavailable = LAND_CHECKOUT_UNAVAILABLE); return }
        _state.value = LandCheckoutState(purchaseKind = kind, cluster = cluster)
        restore(kind)
    }

    /** Re-read authoritative quote fields; storage is only a recovery hint (web `restore`). */
    private suspend fun restore(kind: String) {
        val saved = purchases.read(key(kind)) ?: run { setPhase(LandPhase.IDLE); return }
        setPhase(LandPhase.RESTORING)
        try {
            val identity = me()
            if (kind == "entry" && identity.entryPaid == true) { holder.requireCurrent(session); setPhase(LandPhase.CREDITED); return }
            val deposit = row(saved.id)
            holder.requireCurrent(session)
            adopt(deposit, kind, saved)
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (!holder.isCurrent(session)) return
            if (error is ApiException && error.status == 404) {
                purchases.saveMatching(key(kind), saved.id, null); setPhase(LandPhase.IDLE)
                fail("RESERVATION NOT FOUND — CHOOSE YOUR LAND AGAIN.")
            } else {
                fail("RECONNECTING TO YOUR RESERVED LAND…")
                restoreRetry = scope.launch { delay(bounds().pollMs); if (_state.value.phase == LandPhase.RESTORING) restore(kind) }
            }
        }
    }

    /** A complete reservation becomes the checkout's parcel; any evidence of a started payment resumes
     * reference verification instead of inviting a second signature. */
    private fun adopt(deposit: LandDeposit, kind: String, saved: SavedLandPurchase? = null) {
        val prepared = deposit.requireReservation(kind)
        val id = requireNotNull(prepared.id)
        val storeKey = key(kind)
        val prior = (saved ?: purchases.read(storeKey))?.takeIf { it.id == id }
        val signature = deposit.paymentSignature ?: prior?.signature
        val pendingSubmission = signature != null || prior?.submitted == true
        val observed = now()
        val serverNow = serverMs(prepared.serverNow)
        // The attempt clock is the server's; an older start is clamped to the retry window (web `elapsed`).
        val started = if (pendingSubmission && serverNow != null) (prior?.attemptStartedAt?.takeIf { it <= serverNow } ?: serverNow).let { maxOf(it, serverNow - bounds().firstEntryRetryMs) } else null
        purchases.save(storeKey, SavedLandPurchase(id, signature, prior?.submitted == true, started))
        _state.update { it.copy(reservation = prepared, draftedTile = null, paymentSignature = signature, serverNowMs = serverNow, observedAtMs = observed, attemptStartedAtMs = started, estimate = null, estimateUnavailable = false, estimateLoading = false) }
        if (deposit.status != null && applyTerminal(deposit, prepared)) return
        val payableUntil = serverMs(prepared.payableUntil)
        if (pendingSubmission || (payableUntil != null && (_state.value.serverTime(observed) ?: Long.MAX_VALUE) >= payableUntil)) startPolling(prepared, signature)
        else { setPhase(LandPhase.READY); launchEstimate(prepared) }
    }

    private suspend fun adoptAccepted(accepted: LandReservationAcceptance, kind: String) {
        when {
            accepted.alreadyPaid -> { holder.requireCurrent(session); stopPolling(); setPhase(LandPhase.CREDITED) }
            accepted.recoveredFromRejection -> {
                // The 409 named the wallet's existing reservation; its authoritative row is re-read before adoption.
                val id = requireNotNull(accepted.depositId)
                val deposit = row(id)
                holder.requireCurrent(session)
                adopt(deposit, kind)
                // Web `useEntry.ts reserve`: the copy is selected by the 409's code, never by which fields it carried
                // (the server sends `retryAt` for both codes).
                _state.update { it.copy(notice = when {
                    deposit.terminal -> null
                    accepted.rejectionCode == "RESERVATION_MISMATCH" -> "RESUMED YOUR RESERVED LAND ${deposit.reservationIdentity}."
                    else -> PAYMENT_WINDOW_CLOSED
                }) }
            }
            else -> { holder.requireCurrent(session); adopt(accepted.deposit, kind) }
        }
    }

    private fun applyTerminal(deposit: LandDeposit, prepared: LandDeposit): Boolean {
        val id = requireNotNull(prepared.id)
        if (terminalIntent == id) return true
        val kind = _state.value.purchaseKind
        when (deposit.status) {
            "credited" -> {
                terminalIntent = id; clearGrace(); stopPolling()
                // Entry recovery stays until the next successful visit finds `/me.entryPaid`; a deed completion leaves checkout.
                if (kind == "deed") purchases.saveMatching(key(kind), id, null)
                _state.update { it.copy(phase = LandPhase.CREDITED, error = null) }
            }
            "expired" -> {
                terminalIntent = id; clearGrace(); stopPolling(); purchases.saveMatching(key(kind), id, null)
                _state.update { it.copy(phase = LandPhase.IDLE, reservation = null, paymentSignature = null, attemptStartedAtMs = null,
                    error = "NO PAYMENT WAS CONFIRMED FOR THIS RESERVATION — CHOOSE YOUR LAND AGAIN, THEN PAY ON THE CORRECT NETWORK.") }
            }
            "failed" -> {
                terminalIntent = id; clearGrace(); stopPolling()
                _state.update { it.copy(phase = LandPhase.FAILED, error = "PAYMENT WAS SEEN BUT LAND COULD NOT BE GRANTED — EMAIL $SUPPORT_EMAIL") }
            }
            else -> return false
        }
        return true
    }

    /** Reference polling (`/deposits/:id/paid` once with the signature, `/deposits/:id/verify` every
     * `pollMs`) until the server records a terminal outcome. A transient read never discards a payment. */
    private fun startPolling(prepared: LandDeposit, signature: String?) {
        val id = requireNotNull(prepared.id)
        if (terminalIntent == id || _state.value.reservation?.id != id) return
        stopPolling()
        val sequence = pollSequence
        _state.update { it.copy(phase = LandPhase.CONFIRMING, paymentSignature = signature) }
        poll = scope.launch {
            var acknowledged = signature == null
            while (isActive && pollSequence == sequence && holder.isCurrent(session)) {
                if (!acknowledged) acknowledged = runCatching { bounded { api.post("/deposits/$id/paid", jsonBody("signature" to requireNotNull(signature))) } }.isSuccess
                try {
                    val deposit = LandDeposit.from(bounded { api.post("/deposits/$id/verify") })
                    holder.requireCurrent(session)
                    if (pollSequence == sequence && applyTerminal(deposit, prepared)) return@launch
                } catch (error: CancellationException) { throw error } catch (_: Exception) { /* transient: keep checking */ }
                delay(bounds().pollMs)
            }
        }
    }

    private fun cancelEstimate() {
        estimateSequence++; estimateJob?.cancel(); estimateJob = null
        _state.update { it.copy(estimateLoading = false) }
    }

    private fun launchEstimate(prepared: LandDeposit) {
        val sequence = ++estimateSequence
        val kind = _state.value.purchaseKind
        estimateJob?.cancel()
        fun current() = holder.isCurrent(session) && sequence == estimateSequence &&
            _state.value.phase == LandPhase.READY && _state.value.purchaseKind == kind && _state.value.reservation == prepared
        if (!current()) return
        _state.update { it.copy(estimateLoading = true) }
        estimateJob = scope.launch {
            try {
                val estimate = bounded { prepare(prepared, kind) }.estimate
                if (current()) _state.update { it.copy(estimate = estimate, estimateUnavailable = false) }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) {
                if (current()) _state.update { it.copy(estimate = null, estimateUnavailable = true) }
            } finally {
                if (current()) _state.update { it.copy(estimateLoading = false) }
            }
        }
    }
    /** Funding observations never reserve, sign, broadcast or verify a payment. */
    override suspend fun refreshEstimate() {
        holder.requireCurrent(session)
        _state.value.reservation?.takeIf { _state.value.phase == LandPhase.READY }?.let { launchEstimate(it) }
    }
    private suspend fun prepare(prepared: LandDeposit, kind: String): PreparedLandPayment = LandPayment.prepare(rpc(cluster), addresses(cluster), wallet,
        requireNotNull(prepared.reference), kind, BigInteger(requireNotNull(prepared.amountLamports)))

    override suspend fun reserve(tileId: Int?) {
        holder.requireCurrent(session)
        val current = _state.value
        if (current.phase != LandPhase.IDLE && current.phase != LandPhase.READY) return
        check(current.unavailable == null && activeBounds != null) { LAND_CHECKOUT_UNAVAILABLE }
        check(!observer.blocks(IntentKind.LAND_RESERVATION)) { "Recover the interrupted land reservation before reserving again." }
        val kind = current.purchaseKind
        cancelEstimate()
        _state.update { it.copy(phase = LandPhase.RESERVING, error = null, notice = null, estimateLoading = false) }
        try {
            reservation.submit(LandReservationSpec.intent(wallet, kind, tileId, newKey())) { accepted -> adoptAccepted(accepted.value, kind) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (!holder.isCurrent(session)) throw error
            if (_state.value.phase == LandPhase.RESERVING) setPhase(LandPhase.IDLE)
            if (error is ApiException && error.code == "ENTRY_REQUIRED") {
                _state.update { it.copy(purchaseKind = "entry", error = "This wallet needs its FIRST land — switched to the entry purchase, tap again.") }
            } else fail(error.message ?: "Could not reserve land")
            throw error
        } finally { runCatching { observer.refresh(wallet) } }
    }

    /** One wallet request per explicit tap; server authority is re-read immediately before it. */
    override suspend fun pay(signer: LandSigner) {
        holder.requireCurrent(session)
        var prepared = _state.value.reservation ?: return
        if (_state.value.phase != LandPhase.READY) return
        check(_state.value.unavailable == null && activeBounds != null) { LAND_CHECKOUT_UNAVAILABLE }
        val id = requireNotNull(prepared.id); val kind = _state.value.purchaseKind
        val attempt = ++attemptSequence
        cancelEstimate()
        fun active() = holder.isCurrent(session) && attemptSequence == attempt && _state.value.reservation?.id == id && terminalIntent != id
        _state.update { it.copy(phase = LandPhase.PAYING, error = null, estimateLoading = false) }
        val previous = purchases.read(key(kind))?.takeIf { it.id == id }
        val previousSubmission = previous != null && (previous.submitted || previous.signature != null)
        try {
            val identity = me()
            val deposit = row(id)
            if (!active()) return
            if (kind == "entry" && identity.entryPaid == true) { applyTerminal(LandDeposit(id = id, status = "credited"), prepared); return }
            require(deposit.id == id && (deposit.kind == null || deposit.kind == kind)) { "Land reservation changed" }
            if (applyTerminal(deposit, prepared)) return
            val fresh = deposit.requireReservation(kind)
            require(fresh.reference == prepared.reference && fresh.baseId == prepared.baseId && fresh.reservationIdentity == prepared.reservationIdentity
                && fresh.amountLamports == prepared.amountLamports) { "The reserved parcel changed" }
            // Another device can have confirmed this reference while this one was reviewing.
            if (deposit.paymentSignature != null) { adopt(deposit, kind); return }
            val observed = now()
            _state.update { it.copy(reservation = fresh, serverNowMs = serverMs(fresh.serverNow) ?: it.serverNowMs, observedAtMs = if (fresh.serverNow != null) observed else it.observedAtMs) }
            prepared = fresh
            val payableUntil = serverMs(fresh.payableUntil)
            if (deposit.status != "pending" || payableUntil == null || (_state.value.serverTime(observed) ?: Long.MAX_VALUE) >= payableUntil) {
                startPolling(fresh, previous?.signature); fail(PAYMENT_WINDOW_CLOSED); return
            }
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            if (!active()) return
            if (previousSubmission) startPolling(prepared, previous?.signature) else setPhase(LandPhase.READY)
            fail("COULD NOT CONFIRM YOUR RESERVED LAND — NO NEW PAYMENT WAS REQUESTED. TRY AGAIN WHEN CONNECTED."); return
        }
        var sendStarted = false
        try {
            val payment = bounded { prepare(prepared, kind) }
            if (!active()) return
            _state.update { it.copy(estimate = payment.estimate, estimateUnavailable = false) }
            check(payment.estimate.funded) { "Insufficient SOL including network fee and account rent" }
            // Persist before opening the wallet app, which may evict this process.
            val startedAt = _state.value.serverTime(now())
            purchases.save(key(kind), SavedLandPurchase(id, previous?.signature, submitted = true, attemptStartedAt = startedAt))
            _state.update { it.copy(attemptStartedAtMs = startedAt) }
            sendStarted = true
            grace = scope.launch {
                delay(bounds().walletResponseGraceMs)
                if (!active()) return@launch
                grace = null; startPolling(prepared, null)
                fail("WALLET RESPONSE IS DELAYED — CHECKING THE SAVED PAYMENT. DO NOT SEND ANOTHER PAYMENT.")
            }
            // A late signature may recover an exited checkout but never replaces a newer attempt's signature.
            fun recordSignature(signature: String) {
                val prior = purchases.read(key(kind))
                if (prior?.id == id && (attemptSequence == attempt || prior.signature == null)) purchases.save(key(kind), prior.copy(signature = signature, submitted = true))
            }
            val signature = base58(signer.signAndSend(payment.transaction, cluster, wallet) { recordSignature(base58(it)) }
                .also { require(it.size == 64) { "The wallet returned an invalid payment signature" } })
            recordSignature(signature)
            if (active()) { clearGrace(); startPolling(prepared, signature) }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) {
            if (!active()) return
            clearGrace()
            val refused = !sendStarted || (error is WalletPaymentException && error.refusedBeforeBroadcast)
            if (refused) {
                if (previousSubmission) { startPolling(prepared, previous?.signature); fail("${landPaymentError(error)} YOUR ORIGINAL PAYMENT CHECK CONTINUES.") }
                else { stopPolling(); purchases.saveMatching(key(kind), id, SavedLandPurchase(id)); _state.update { it.copy(phase = LandPhase.READY, attemptStartedAtMs = null) }; fail(landPaymentError(error)) }
                return
            }
            // buy_sink is repeatable: keep the durable submitted marker until the server proves the outcome.
            startPolling(prepared, null)
            fail("WALLET RESPONSE WAS INTERRUPTED — CHECKING YOUR PAYMENT BEFORE ANOTHER ATTEMPT.${paymentDetail(error).uppercase()}")
        }
    }

    /** The countdown authorizes only another explicit check and signature for the one-time pay_entry. */
    override suspend fun retryPayment(signer: LandSigner) {
        holder.requireCurrent(session)
        val prepared = _state.value.reservation ?: return
        val id = requireNotNull(prepared.id)
        check(_state.value.unavailable == null && activeBounds != null) { LAND_CHECKOUT_UNAVAILABLE }
        if (!_state.value.canRetryEntry(now(), bounds())) return
        val sequence = ++attemptSequence
        fun active() = holder.isCurrent(session) && attemptSequence == sequence && _state.value.reservation?.id == id && terminalIntent != id
        _state.update { it.copy(retrying = true, error = null) }
        clearGrace(); stopPolling()
        try {
            val identity = me()
            val deposit = LandDeposit.from(bounded { api.post("/deposits/$id/verify") })
            if (!active()) return
            if (identity.entryPaid == true) { applyTerminal(LandDeposit(id = id, status = "credited"), prepared); return }
            require(deposit.id == id && (deposit.kind == null || deposit.kind == "entry")) { "Land reservation changed" }
            if (applyTerminal(deposit, prepared)) return
            val fresh = deposit.requireReservation("entry")
            require(fresh.reference == prepared.reference && fresh.baseId == prepared.baseId && fresh.reservationIdentity == prepared.reservationIdentity
                && fresh.amountLamports == prepared.amountLamports) { "The reserved parcel changed" }
            if (deposit.paymentSignature != null) { adopt(deposit, "entry"); return }
            val observed = now()
            _state.update { it.copy(reservation = fresh, serverNowMs = serverMs(fresh.serverNow) ?: it.serverNowMs, observedAtMs = if (fresh.serverNow != null) observed else it.observedAtMs) }
            val payableUntil = serverMs(fresh.payableUntil)
            check(deposit.status == "pending" && payableUntil != null && (_state.value.serverTime(observed) ?: Long.MAX_VALUE) < payableUntil) { "The payment window changed — continuing to check your saved payment." }
            _state.update { it.copy(phase = LandPhase.READY, retrying = false) }
            pay(signer)
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            if (active()) { startPolling(prepared, purchases.read(key("entry"))?.takeIf { it.id == id }?.signature); fail("COULD NOT CONFIRM A SAFE RETRY — STILL CHECKING YOUR SAVED PAYMENT.") }
        } finally { if (holder.isCurrent(session)) _state.update { it.copy(retrying = false) } }
    }

    companion object {
        /** The one support contact the app carries (web `lib/support.ts`). */
        const val SUPPORT_EMAIL = "support@pixelkingdomwars.com"
        /** Web `useEntry.ts`: a `PAYMENT_WINDOW_CLOSING` 409 and a reservation past `payableUntil` say the same thing. */
        const val PAYMENT_WINDOW_CLOSED = "PAYMENT WINDOW CLOSED — CHECKING BEFORE RELEASING YOUR RESERVATION."
        /** The loaded pack lacks `constants.LAND_CHECKOUT_RECOVERY`; the checkout refuses every step rather than invent a timer. */
        const val LAND_CHECKOUT_UNAVAILABLE = "LAND CHECKOUT NEEDS A GAME CONTENT UPDATE — APPLY THE AVAILABLE UPDATE OR UPDATE THE APP TO BUY LAND. YOUR SAVED RESERVATION AND PAYMENT ARE KEPT."
        /** Web `landPaymentError`, over the wallet module's own classification. */
        fun landPaymentError(cause: Throwable): String {
            val message = cause.message.orEmpty()
            return when {
                cause is WalletPaymentException -> cause.message ?: "PAYMENT COULD NOT BE COMPLETED — CHECK YOUR WALLET AND TRY AGAIN."
                message.contains("Insufficient SOL") -> "NOT ENOUGH SOL — ADD FUNDS, INCLUDING THE NETWORK FEE, THEN TRY AGAIN."
                cause is SolanaRpcException || cause is ApiException || cause is IOException || message.contains("funding estimate unavailable", ignoreCase = true) ->
                    "COULD NOT CHECK SOL AND FEES — YOUR LAND IS RESERVED. RETRY WHEN CONNECTED."
                else -> "PAYMENT COULD NOT BE COMPLETED — CHECK YOUR WALLET AND TRY AGAIN."
            }
        }
    }
}
