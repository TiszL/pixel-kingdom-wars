package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.jsonBody
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.math.BigInteger
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.JsonObject

/** The signature callback runs before either wallet's single RPC broadcast.
 * The attempted marker is durable before either wallet receives the transaction. */
fun interface KeepDepositSender {
    suspend fun send(transaction: ByteArray, quote: KeepDepositQuote, recordSignature: (String) -> Unit): String
}
data class KeepDepositState(val saved: SavedKeepDeposit? = null, val busy: Boolean = false,
    val loaded: Boolean = false, val error: String? = null, val feeLamports: String? = null,
    val quoteFresh: Boolean = false, val hydrated: Boolean = false,
    /** Set when an attempted deposit that never went through was retired ([UnpaidAttempt]); cleared by the next quote. */
    val notice: String? = null,
    /** The server ended the saved deposit unpaid, yet the cluster knows its recorded signature — or answers null for
     * one saved without the block height that could prove the null final: support, never retired. */
    val paymentFound: Boolean = false) {
    val canPay get() = loaded && !busy && quoteFresh && saved != null && !saved.attempted && saved.receipt == null
    val uncertain get() = saved?.attempted == true && saved.receipt?.status != "credited"
}

/** One repeatable SPL transfer, then exact reference/ID recovery. Balances and elapsed time prove nothing. */
class KeepDepositRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: KeepDepositStore, private val cluster: SolanaCluster,
    private val mint: () -> String, private val bounds: () -> KeepDepositBounds?,
    private val preparePayment: suspend (KeepDepositQuote) -> PreparedKeepDeposit,
    private val refreshWallet: suspend () -> Unit = {},
    /** Production supplies Android elapsedRealtime, which includes deep sleep. Never wall clock/uptime. */
    private val monotonicMs: () -> Long,
    /** Read-only cluster verdict on a recorded signature and the last-valid block height saved with its payment
     * ([UnpaidAttempt]). Unavailable fails closed: nothing retires. */
    private val signatureLanding: suspend (String, Long?) -> SignatureLanding = { _, _ -> throw IOException("Signature status is unavailable.") },
    /** Wall clock, used ONLY for the persisted start of a wallet attempt, which must survive process death and
     * reboot. The payment window above stays monotonic. */
    private val wallClockMs: () -> Long = System::currentTimeMillis,
) {
    private val mutable = MutableStateFlow(KeepDepositState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    /** Never persisted: a previous boot/process cannot prove a pending quote remains payable. */
    private var freshQuote: Pair<String, Long>? = null
    fun requirePaymentWindow(quote: KeepDepositQuote) {
        holder.requireCurrent(session)
        if (!quoteFresh(quote)) {
            mutable.update { it.copy(quoteFresh = false) }
            error("This unpaid quote needs a new review before payment. Close it, then review a new deposit.")
        }
    }
    private fun quoteFresh(quote: KeepDepositQuote): Boolean = freshQuote?.let { (id, deadline) -> id == quote.id && monotonicMs() < deadline } == true
    private suspend fun guard() { currentCoroutineContext().ensureActive(); holder.requireCurrent(session) }
    private fun limits() = requireNotNull(bounds()) { "Deposit controls need the current game content." }
    private suspend fun <T> bounded(block: suspend () -> T): T = try { withTimeout(limits().timeoutMs) { block() } }
        catch (_: TimeoutCancellationException) { throw IOException("Deposit request timed out. Your saved payment is kept.") }
    private suspend fun action(block: suspend () -> Unit) {
        if (!admission.tryLock()) return
        try { guard(); mutable.update { it.copy(busy = true, error = null) }; block() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { holder.requireCurrent(session); mutable.update { it.copy(error = e.message ?: "Deposit check interrupted. Your saved payment is kept.") } }
        finally { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false) }; admission.unlock() }
    }
    private fun publish(saved: SavedKeepDeposit?) { holder.requireCurrent(session); mutable.update {
        it.copy(saved = saved, loaded = true, quoteFresh = saved?.quote?.let(::quoteFresh) == true,
            hydrated = it.hydrated && it.saved?.quote == saved?.quote && it.saved?.receipt == saved?.receipt,
            paymentFound = it.paymentFound && saved?.unpaidEnd == true && it.saved?.quote == saved.quote)
    } }

    suspend fun open() = action {
        val saved = store.read(); publish(saved)
        if (saved != null) reconcile(saved, verify = saved.attempted)
    }
    suspend fun create(input: String) = action {
        check(mutable.value.loaded) { "Load saved deposits first." }
        check(store.read() == null) { "Finish or close the saved deposit first." }
        val limits = limits(); val amount = limits.amount(input); val expectedMint = mint()
        val started = monotonicMs()
        // No server idempotency key exists for quote creation. No wallet is opened until its full reply is saved.
        val raw = bounded { api.post("/deposits", jsonBody("kind" to "keep_deposit")) }; guard()
        val quote = KeepDepositQuote.from(raw, session.wallet, session.origin, cluster.id, amount, expectedMint, limits.decimals)
        check(KeepDepositPayment.sourceAta(quote.wallet, quote.mint) == quote.source) { "The deposit source is not your wallet's KEEP account." }
        guard(); store.save(SavedKeepDeposit(quote)); freshQuote = quote.id to Math.addExact(started, limits.quoteWindowMs); publish(store.read())
        mutable.update { it.copy(notice = null) }
    }
    suspend fun close() = action {
        val saved = requireNotNull(store.read())
        check(!saved.attempted || mutable.value.hydrated) { "The deposit is confirmed; refresh account and balances before finishing." }
        store.clearUnpaidOrCredited(saved.quote.id); freshQuote = null; publish(null)
    }
    suspend fun check() = action { store.read()?.let { reconcile(it, verify = true) } }

    private suspend fun reconcile(saved: SavedKeepDeposit, verify: Boolean) {
        if (saved.receipt?.status == "credited") { hydrate(); return }
        val q = saved.quote
        // A deposit the server ended unpaid can never be credited: no /paid, no /verify, only the GET that lets
        // [retireIfUnpaid] decide.
        val mutate = verify && !saved.unpaidEnd
        if (mutate && saved.signature != null) {
            try { bounded { api.post("/deposits/${q.id}/paid", jsonBody("signature" to saved.signature)) }; guard() }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { guard() /* Reference verification remains available when signature commitment is unavailable. */ }
        }
        val raw = bounded { if (mutate) api.post("/deposits/${q.id}/verify") else api.get("/deposits/${q.id}") }; guard()
        adopt(raw, saved)
        if (mutable.value.saved?.receipt?.status == "credited") hydrate() else retireIfUnpaid(raw)
        guard()
    }
    /** [UnpaidAttempt]: runs on the detail the server just returned for this id + reference ([adopt] checked both).
     * One read-only RPC at most, never a mutation. */
    private suspend fun retireIfUnpaid(raw: JsonObject) {
        val saved = store.read() ?: return; val now = wallClockMs()
        // This quote has no deadline of its own: the server's creation time plus the catalogue window bounds any attempt.
        val legacyDeadline = runCatching { Math.addExact(Instant.parse(requireNotNull(raw.string("createdAt"))).toEpochMilli(), limits().quoteWindowMs) }.getOrNull()
        if (!saved.unpaidAttemptEnded(now, legacyDeadline)) return
        val landing = saved.signature?.let { signature ->
            try { bounded { signatureLanding(signature, saved.lastValidBlockHeight) }.also { guard() } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { guard(); return /* Fail closed: the deposit stays saved and a later check asks again. */ }
        }
        // A null status the node cannot yet prove final (it has not finalized past the saved height, or that read
        // failed): nothing retires and a later check asks again. Without a saved height it can never be proven, which
        // [UnpaidAttempt.cleared] refuses below: support.
        if (landing == SignatureLanding.UNPROVEN && saved.lastValidBlockHeight != null) return
        if (!UnpaidAttempt.cleared(saved.signature, landing, saved.lastValidBlockHeight)) { mutable.update { it.copy(paymentFound = true) }; return }
        store.retireUnpaidAttempt(saved.quote.id, saved.quote.reference, now, legacyDeadline, landing); freshQuote = null; publish(null)
        mutable.update { it.copy(notice = UnpaidAttempt.notice(landing, deposit = true)) }
    }
    private suspend fun hydrate() {
        refreshWallet(); guard()
        mutable.update { it.copy(hydrated = true) }
    }
    private fun adopt(raw: JsonObject, saved: SavedKeepDeposit) {
        val q = saved.quote
        require(raw.string("id") == q.id && raw.string("kind") == "keep_deposit" && raw.string("reference") == q.reference) { "The server returned a different deposit. Your original payment is kept." }
        val status = raw.string("status")
        require(status in setOf("pending", "finalized", "credited", "expired", "failed")) { "Unknown deposit status. Your payment is kept." }
        val payment = raw.string("paymentSignature")
        val transaction = raw.string("txSignature")
        listOfNotNull(payment, transaction).forEach { require(KeepDepositPayment.validSignature(it)) { "Invalid deposit payment signature." } }
        if (saved.signature != null) require(listOfNotNull(payment, transaction).all { it == saved.signature }) { "Deposit signature differs from the saved payment. Contact support." }
        val amount = raw.string("amount")
        if (status == "credited" || status == "finalized") {
            require(transaction != null && amount == q.baseUnits.toString()) { "Deposit amount or finalized signature differs from the reviewed transfer. Contact support." }
        }
        val observedSignature = saved.signature ?: transaction ?: payment
        val terminal = if (status in setOf("credited", "expired", "failed")) KeepDepositReceipt(requireNotNull(status), transaction, amount) else null
        publish(store.update(q.id) { it.copy(attempted = it.attempted || observedSignature != null || status == "finalized" || status == "credited",
            signature = observedSignature, receipt = terminal) })
    }

    suspend fun pay(sender: KeepDepositSender) = action {
        var saved = requireNotNull(store.read()) { "Review a KEEP deposit first." }
        check(!saved.attempted && saved.receipt == null) { "Check the saved payment; do not send another transfer." }
        val q = saved.quote
        requirePaymentWindow(q)
        check(q.cluster == cluster.id && q.mint == mint() && limits().decimals == q.decimals) { "The network changed. Your quote is kept." }
        // Detail confirms identity/status only. Never replace the frozen source/destination/amount from it.
        reconcile(saved, verify = false); guard()
        saved = requireNotNull(store.read())
        if (saved.attempted || saved.receipt != null) return@action
        val prepared = bounded { preparePayment(q) }; guard()
        requirePaymentWindow(q)
        mutable.update { it.copy(feeLamports = prepared.feeLamports.toString()) }
        store.update(q.id) { it.copy(attempted = true, attemptedAtMs = wallClockMs(), walletEndedAtMs = null, lastValidBlockHeight = prepared.lastValidBlockHeight) }; publish(store.read())
        try {
            val signature = sender.send(prepared.transaction, q) { signature ->
                // No suspension between identity guard and durable signature write.
                holder.requireCurrent(session); require(KeepDepositPayment.validSignature(signature))
                store.update(q.id) { current ->
                    check(current.signature == null || current.signature == signature)
                    // A signature is recorded only from the wallet step, so it also stamps that step's end.
                    current.copy(attempted = true, signature = signature).walletEnded(wallClockMs())
                }
            }
            guard(); require(KeepDepositPayment.validSignature(signature))
            store.update(q.id) { current -> check(current.signature == null || current.signature == signature); current.copy(signature = signature).walletEnded(wallClockMs()) }
            publish(store.read()); reconcile(requireNotNull(store.read()), verify = true)
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            guard()
            if (store.read()?.receipt?.status == "credited") {
                publish(store.read())
                throw IOException("Your deposit is confirmed. Reconnect to refresh account and balances before finishing.")
            }
            // Only a positive MWA/pre-sign-only refusal with NO recorded signature permits another explicit approval.
            if (e is WalletPaymentException && e.refusedBeforeBroadcast && store.read()?.signature == null) {
                store.update(q.id) { it.copy(attempted = false, attemptedAtMs = null, walletEndedAtMs = null, lastValidBlockHeight = null) }; publish(store.read())
                throw IOException(notSentNotice(e, "Your reviewed deposit is kept; approve it when ready."))
            }
            // Uncertain: the wallet could broadcast until this moment, so the retire margin is counted from here.
            store.read()?.takeIf { it.quote.id == q.id && it.attempted }?.let { store.update(q.id) { current -> current.walletEnded(wallClockMs()) } }
            publish(store.read())
            stoppedBeforeRelayNotice(e, "Check this saved deposit; do not send another transfer.")?.let { throw IOException(it) }
            throw IOException("Payment outcome is uncertain${paymentDetail(e)}. Check this saved deposit; do not send another transfer.")
        }
    }
}
