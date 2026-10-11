package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

/** The callback persists before relay, including when the wallet already sent after logout.
 * Its boolean is true ONLY when the signed transaction retained the prepared blockhash. */
fun interface GemsBuySender {
    suspend fun send(transaction: ByteArray, quote: GemsBuyIntent, recordSignature: (String, Boolean) -> Unit): String
}
data class GemsBuyState(val saved: SavedGemsBuy? = null, val busy: Boolean = false,
    val available: Boolean = false, val capability: GemsCapability? = null, val fresh: Boolean = false,
    val hydrated: Boolean = false, val feeLamports: String? = null) {
    val canPay get() = !busy && fresh && saved?.quote != null && saved.attempted == false && saved.observed?.status == "pending"
}

/** Wallet KEEP -> Gems only. No base selector, ledger journal or KEEP custody state is shared. */
class GemsBuyRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: GemsBuyStore, private val cluster: SolanaCluster,
    private val mint: () -> String, private val bounds: () -> KeepDepositBounds?,
    private val prepare: suspend (GemsBuyIntent) -> PreparedKeepDeposit,
    private val hydrate: suspend () -> Unit, private val monotonicMs: () -> Long,
    /** ECONOMY.depositReuseMinRemainingMin, supplied from the current server catalogue. */
    private val paymentMarginMs: () -> Long?,
    private val wallClockMs: () -> Long = System::currentTimeMillis,
    private val newKey: () -> String = { UUID.randomUUID().toString() }) {
    private val mutable = MutableStateFlow(GemsBuyState(saved = store.read())); val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var fresh: Pair<GemsBuyIntent, Long>? = null
    private var epoch = 0L
    private suspend fun guard() { currentCoroutineContext().ensureActive(); holder.requireCurrent(session) }
    private fun limits() = requireNotNull(bounds()) { "Wallet payment controls need current game content." }
    private suspend fun <T> request(block: suspend () -> T): T {
        guard()
        // Read-only recovery must also work before a catalogue loads. This fallback is a transport
        // timeout, not a game duration; new payment admission still requires catalogue controls.
        return try { withTimeout(bounds()?.timeoutMs ?: 15_000L) { block() }.also { guard() } }
        catch (_: TimeoutCancellationException) { throw java.io.IOException("The request timed out. Your original wallet purchase is saved.") }
    }
    private fun publish() {
        holder.requireCurrent(session)
        val saved = store.read()
        mutable.update { it.copy(saved = saved, fresh = saved?.quote?.let(::isFresh) == true,
            hydrated = it.hydrated && it.saved?.observed?.receipt == saved?.observed?.receipt) }
    }
    private suspend fun <T> action(block: suspend () -> T): T {
        guard(); check(admission.tryLock()) { "A wallet purchase is already in progress." }
        mutable.update { it.copy(busy = true) }
        try { return block() } finally {
            try { if (holder.isCurrent(session)) { publish(); mutable.update { it.copy(busy = false) } } }
            finally { admission.unlock() }
        }
    }
    fun dismiss() { epoch++; fresh = null; if (holder.isCurrent(session)) publish() }
    private fun isFresh(q: GemsBuyIntent) = fresh?.let { it.first == q && monotonicMs() < it.second } == true
    fun requirePaymentWindow(q: GemsBuyIntent) {
        holder.requireCurrent(session); check(isFresh(q)) { "Review the original wallet purchase again before signing." }
        check(store.read()?.quote == q) { "The saved purchase changed." }
    }
    private suspend fun capability(): GemsCapability {
        mutable.update { it.copy(available = false) }
        val cap = NativeCapabilities.from(request { api.get("/native/capabilities") }).economy?.gems
        check(cap?.enabled == true && "wallet-keep" in cap.sources && cap.destinationAta != null) { "Wallet Gems purchases are unavailable. Saved payments remain recoverable." }
        check(cap.gemsPerKeep == 1L && KeepDepositPayment.validAddress(requireNotNull(cap.destinationAta))) { "The wallet Gems backing or reserve is unsupported." }
        mutable.update { it.copy(available = true, capability = cap) }; return cap
    }
    private fun validateTerms(s: SavedGemsBuy, cap: GemsCapability) {
        require(s.draft.keepIn in cap.minConvertKeep..cap.maxConvertKeepPerTx) { "The saved amount is outside current purchase bounds." }
        s.quote?.let { q -> check(q.mint == mint() && q.decimals == limits().decimals && q.destination == cap.destinationAta) { "The network or reserve changed. Keep the original purchase for recovery." } }
    }
    private suspend fun validateQuote(q: GemsBuyIntent, d: GemsBuyDraft) {
        q.validate()
        require(q.wallet == d.wallet && q.idempotencyKey == d.idempotencyKey && q.keepIn == d.keepIn)
        require(listOf(q.wallet, q.source, q.destination, q.mint, q.reference).all(KeepDepositPayment::validAddress))
        check(KeepDepositPayment.sourceAta(q.wallet, q.mint) == q.source) { "The quote does not use your wallet's KEEP account." }
    }
    private suspend fun observe(s: SavedGemsBuy): GemsBuyRecovery {
        val r = GemsBuyRecovery.from(request { api.get("/gems/buy/by-key/${s.draft.idempotencyKey}") }, session.wallet, s.draft.idempotencyKey)
        check(r.deposit != null || s.quote == null) { "The original known purchase is unavailable. Keep its saved payment evidence." }
        r.deposit?.let { o ->
            validateQuote(o.originalIntent, s.draft); guard()
            store.update(s.draft) { current ->
                current.copy(quote = o.originalIntent, observed = o,
                    attempted = current.attempted || o.paymentSignature != null || o.txSignature != null || o.amount != null || o.status in setOf("finalized", "credited", "failed"))
            }
            publish()
        }
        return r
    }
    private suspend fun hydrateReceipt() {
        if (store.read()?.observed?.receipt == null) return
        request { hydrate() }; mutable.update { it.copy(hydrated = true) }
    }
    private suspend fun reconcilePayment(): GemsBuyRecovery {
        val recovery = observe(requireNotNull(store.read()))
        val s = requireNotNull(store.read()); val q = s.quote
        val recoverable = s.observed?.status in setOf("pending", "finalized") ||
            (s.observed?.status == "expired" && recovery.expiredPaymentRecovery == 1)
        if (q == null || !s.attempted || !recoverable) return recovery
        s.signature?.let { sig ->
            try { request { api.post("/deposits/${q.id}/paid", buildJsonObject { put("signature", sig) }) } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { guard() } // A finalized reference fallback can still prove the original credit.
        }
        request { api.post("/deposits/${q.id}/verify") }
        return observe(requireNotNull(store.read()))
    }
    /** Always publishes local evidence first. No lifecycle path opens a wallet or POSTs. */
    suspend fun open() = action {
        publish()
        val s = store.read()
        if (s != null) {
            if (s.observed?.receipt == null) observe(s)
            hydrateReceipt()
        } else capability()
        Unit
    }
    /** First explicit review persists identity BEFORE even the recovery-capability probe. */
    suspend fun review(input: String) = action {
        check(store.read() == null) { "Check the original saved purchase first." }
        val amount = limits().amount(input).toLong()
        require(amount <= (1L shl 53) - 1)
        val d = GemsBuyDraft(session.wallet, session.origin, cluster.id, newKey(), amount)
        store.begin(d); publish(); reviewOriginal()
    }
    /** Explicit same-key intent retry/review; creation is not a token transfer. */
    suspend fun reviewSaved() = action { reviewOriginal() }
    private suspend fun reviewOriginal() {
        fresh = null; val e = epoch
        val s = requireNotNull(store.read())
        check(!s.attempted && s.observed?.receipt == null) { "Check the saved payment; do not send another transfer." }
        // Valid v1 recovery proves the server can recover a lost creation response. Old servers fail closed.
        check(observe(s).expiredPaymentRecovery == 1) { "This server cannot recover late wallet payments. Keep the saved purchase for recovery." }
        val current = requireNotNull(store.read())
        check(!current.attempted && current.observed?.status !in setOf("expired", "failed", "credited", "finalized")) { "The original intent is no longer payable." }
        val cap = capability(); validateTerms(current, cap)
        val started = monotonicMs()
        val raw = request { api.post("/deposits", buildJsonObject {
            put("kind", "gems_buy"); put("keepIn", s.draft.keepIn); put("idempotencyKey", s.draft.idempotencyKey)
        }) }
        val q = raw.decode<GemsBuyIntent>(); validateQuote(q, s.draft); guard()
        check(raw.string("status") == "pending") { "The original intent is no longer payable." }
        val serverNow = Instant.parse(requireNotNull(raw.string("serverNow"))).toEpochMilli()
        val remaining = Math.subtractExact(Instant.parse(q.expiresAt).toEpochMilli(), serverNow)
        // Server admits replay only within its remaining-time safety margin. Use a monotonic local window,
        // bounded by both this original expiry and the server-catalogue payment window; never extend a quote.
        val margin = requireNotNull(paymentMarginMs()) { "Load the server payment safety margin before signing." }
        require(margin > 0)
        val window = minOf(Math.subtractExact(remaining, margin), limits().quoteWindowMs)
        check(window > limits().timeoutMs) { "This quote is too close to expiry for payment." }
        val saved = store.update(s.draft) { it.copy(quote = q) }; validateTerms(saved, cap)
        check(observe(saved).expiredPaymentRecovery == 1) { "Wallet payment recovery changed. Review later." }
        val final = requireNotNull(store.read())
        check(!final.attempted && final.observed?.status == "pending" && epoch == e)
        fresh = q to Math.addExact(started, window); publish()
    }
    /** Explicit status reconciliation. /paid and /verify reconcile the original transfer; they never send KEEP. */
    suspend fun check() = action {
        val s = requireNotNull(store.read())
        if (s.observed?.receipt != null) { hydrateReceipt(); return@action }
        reconcilePayment()
        hydrateReceipt()
    }
    /** User cancellation only. Unknown is allowed for creation-only drafts; a wallet attempt
     * or any evidence of payment is never abandoned, even if the server later says expired. */
    suspend fun abandon() = action {
        val s = requireNotNull(store.read()); check(!s.attempted && s.signature == null)
        val proof = GemsBuyRecovery.from(request { api.get("/gems/buy/by-key/${s.draft.idempotencyKey}") }, session.wallet, s.draft.idempotencyKey)
        val deposit = proof.deposit
        deposit?.let { validateQuote(it.originalIntent, s.draft) }; guard()
        // A lost creation response can disclose the original quote during this explicit cancellation.
        val expected = if (s.quote == null && deposit != null) {
            store.update(s.draft) { current -> check(current == s); current.copy(quote = deposit.originalIntent) }
        } else s
        store.abandon(expected, proof, wallClockMs()); fresh = null
    }
    suspend fun finish() = action { store.finish(requireNotNull(store.read()).draft, mutable.value.hydrated); fresh = null }
    suspend fun pay(sender: GemsBuySender) = action {
        val original = requireNotNull(store.read()); val q = requireNotNull(original.quote)
        check(!original.attempted); requirePaymentWindow(q)
        val cap = capability(); validateTerms(original, cap)
        check(observe(original).expiredPaymentRecovery == 1) { "This server cannot recover late wallet payments. Keep the saved purchase for recovery." }
        val observed = requireNotNull(store.read())
        check(!observed.attempted && observed.observed?.status == "pending") { "The original payment is already being processed." }
        val payment = request { prepare(q) }; requirePaymentWindow(q)
        mutable.update { it.copy(feeLamports = payment.feeLamports.toString()) }
        // Shared-store CAS prevents another session from handing this same quote to a wallet concurrently.
        store.update(original.draft) { check(!it.attempted); it.copy(attempted = true,
            attemptedAtMs = wallClockMs(), preparedLastValidHeight = payment.lastValidBlockHeight) }
        publish()
        fun record(sig: String, exactBlockhash: Boolean) {
            require(KeepDepositPayment.validSignature(sig))
            // Deliberately NO session guard: MWA may already have sent after logout. Save into this original store.
            store.update(original.draft) { it.copy(signature = sig,
                signatureUsesPreparedHeight = exactBlockhash && it.preparedLastValidHeight != null).ended(wallClockMs()) }
        }
        try {
            val signature = sender.send(payment.transaction, q, ::record)
            // A conforming sender records before relay. Returning without recording is uncertain, never retryable.
            check(store.read()?.signature == signature) { "Wallet returned without durable signature evidence." }
            guard(); publish()
            // Recovery uses an authenticated GET first; publication never infers credit from wallet success.
            reconcilePayment(); hydrateReceipt()
        } catch (e: Exception) {
            val current = store.read()
            if (current?.draft == original.draft && e is WalletPaymentException && e.refusedBeforeBroadcast && current.signature == null) {
                store.update(original.draft) { it.copy(attempted = false, attemptedAtMs = null, walletEndedAtMs = null, preparedLastValidHeight = null) }
            }
            throw e
        } finally {
            store.read()?.takeIf { it.draft == original.draft && it.attempted }?.let { store.update(original.draft) { it.ended(wallClockMs()) } }
        }
    }
}
