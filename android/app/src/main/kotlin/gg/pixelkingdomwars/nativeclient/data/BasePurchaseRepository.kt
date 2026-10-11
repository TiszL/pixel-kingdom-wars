package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class BasePurchaseUiState(val loaded: Boolean = false, val supported: Boolean = false, val enabled: Boolean = false,
    val busy: Boolean = false, val error: String? = null, val review: BasePurchaseOffer? = null, val saved: SavedBasePurchase? = null,
    val quoteFresh: Boolean = false, val hydrated: Boolean = false, val unavailable: String? = null, val feeLamports: String? = null,
    /** Set when an attempted payment that never went through was retired ([UnpaidAttempt]); cleared by the next quote. */
    val notice: String? = null,
    /** The server ended the saved purchase unpaid, yet the cluster knows its recorded signature — or answers null for
     * one saved without the block height that could prove the null final: support, never retired. */
    val paymentFound: Boolean = false) {
    val canPay get() = loaded && supported && enabled && !busy && quoteFresh && saved?.purchase?.status == "pending" && !saved.attempted
}

/** V1 draft/quote followed by a single wallet handoff. Opening or restoring only observes (GET) and never pays.
 * The purchase screen's auto-confirm calls [reconcile] on the catalogue cadence for an ATTEMPTED payment only (the
 * web's useSolPurchase loop: same-signature /paid + idempotent /verify); an unattempted quote is never verified by a
 * lifecycle, because verification can expire it. Only the explicit PAY tap ever opens a wallet. */
class BasePurchaseRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val store: BasePurchaseStore, private val cluster: SolanaCluster,
    private val selectedBaseId: () -> String?, private val directory: () -> BaseDirectory?,
    private val catalogue: () -> JsonObject?, private val actionsAllowed: () -> Boolean,
    private val refreshAccount: suspend () -> Unit, private val refreshSelected: suspend () -> Unit,
    private val preparePayment: suspend (BasePurchaseQuote) -> PreparedBasePurchase,
    private val monotonicMs: () -> Long,
    /** Read-only cluster verdict on a recorded signature and the last-valid block height saved with its payment
     * ([UnpaidAttempt]). Unavailable fails closed: nothing retires. */
    private val signatureLanding: suspend (String, Long?) -> SignatureLanding = { _, _ -> throw IOException("Signature status is unavailable.") },
    /** Wall clock: the persisted start of a wallet attempt must survive process death and reboot. */
    private val wallClockMs: () -> Long = System::currentTimeMillis) {
    private val mutable = MutableStateFlow(BasePurchaseUiState()); val state = mutable.asStateFlow()
    private val admission = Mutex(); private var epoch = 0L; private var actionEpoch: Long? = null
    private var actionCatalogue: JsonObject? = null; private var selected: String? = null; private var paymentAction = false
    private var fresh: Pair<BasePurchaseQuote, Long>? = null
    private var reviewCatalogue: JsonObject? = null
    private suspend fun guard() {
        currentCoroutineContext().ensureActive(); holder.requireCurrent(session)
        check(actionEpoch == null || actionEpoch == epoch) { "This review closed. The original saved purchase is kept." }
        if (paymentAction) {
            check(selected == selectedBaseId() && catalogue() == actionCatalogue && actionsAllowed()) { "The base or game content changed. Review the original purchase again." }
        }
    }
    fun dismiss() { epoch++; reviewCatalogue = null; if (holder.isCurrent(session)) mutable.update { it.copy(review = null, notice = null) } }
    private fun timeoutMs(): Long = requireNotNull(((catalogue()?.get("constants") as? JsonObject)?.get("LAND_CHECKOUT_RECOVERY") as? JsonObject)?.string("requestTimeoutMs"))
        .toLong().also { require(it > 0) }
    /** Catalogue cadence for confirming an attempted payment (`LAND_CHECKOUT_RECOVERY.pollMs`, the web's verify loop).
     * Null fails closed: no automatic confirmation, the manual CHECK under DETAILS remains. */
    fun pollMs(): Long? = ((catalogue()?.get("constants") as? JsonObject)?.get("LAND_CHECKOUT_RECOVERY") as? JsonObject)?.string("pollMs")?.toLongOrNull()?.takeIf { it > 0 }
    private suspend fun <T> bounded(block: suspend () -> T): T {
        guard()
        return try { withTimeout(timeoutMs()) { block() }.also { guard() } }
        catch (_: TimeoutCancellationException) { throw IOException("Purchase request timed out. The original draft and payment remain saved.") }
    }
    private suspend fun action(payment: Boolean = false, block: suspend () -> Unit) {
        if (!admission.tryLock()) return
        actionEpoch = epoch; paymentAction = payment; selected = selectedBaseId(); actionCatalogue = catalogue()
        try { guard(); mutable.update { it.copy(busy = true, error = null) }; block() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { holder.requireCurrent(session); mutable.update { it.copy(error = e.message ?: "Check the original saved purchase.") } }
        finally {
            try { if (holder.isCurrent(session)) {
                try { publish() } catch (_: Exception) { mutable.update { it.copy(loaded = false, quoteFresh = false, error = "Saved purchase storage is unavailable. Reconnect before continuing.") } }
                mutable.update { it.copy(busy = false) }
            } } finally { actionEpoch = null; paymentAction = false; admission.unlock() }
        }
    }
    private fun publish(saved: SavedBasePurchase? = store.read()) {
        holder.requireCurrent(session)
        mutable.update { it.copy(loaded = true, saved = saved, quoteFresh = saved?.purchase?.quote?.let(::quoteFresh) == true,
            hydrated = it.hydrated && it.saved?.request == saved?.request && it.saved?.purchase?.receipt == saved?.purchase?.receipt,
            unavailable = if (it.saved?.request == saved?.request) it.unavailable else null,
            paymentFound = it.paymentFound && saved?.unpaidEnd == true && it.saved?.request == saved.request) }
    }
    private fun quoteFresh(q: BasePurchaseQuote) = fresh?.let { (quote, deadline) -> quote == q && monotonicMs() < deadline } == true
    private fun requireOriginal(baseId: String, quote: BasePurchaseQuote? = null) {
        val dir = requireNotNull(directory()) { "Refresh the original deed directory first." }
        require(dir.stableMutations && selectedBaseId() == baseId) { "Select the original active deed before approving this purchase." }
        val base = dir.bases.single { it.id == baseId && it.selectable }
        if (quote != null) require(base.deedAssetId == quote.deedAssetId && base.landPaidAt == quote.landPaidAt) { "The original deed ownership changed. Keep its saved purchase for recovery." }
    }
    private fun validateRail(q: BasePurchaseQuote) {
        val a = ChainAddresses.forCluster(cluster); val r = q.rail
        require(q.wallet == session.wallet && r.cluster == cluster.id && r.coreProgram == a.coreProgram && r.configPda == a.config
            && r.treasuryLiquidity == a.treasuryLiquidity && r.treasuryDev == a.treasuryDev && r.treasuryOps == a.treasuryOps)
        // The independently reviewed primitive validates exact accounts, direct recipient and positive u64.
        BasePurchasePayment.instructions(a, BasePurchaseKind.entries.single { it.wire == q.request.kind }, q.wallet, q.reference, q.amountLamports.toBigInteger(), r.destination,
            r.directLamports?.toBigInteger(), r.splitLamports?.toBigInteger())
    }
    fun requirePaymentWindow(q: BasePurchaseQuote) {
        holder.requireCurrent(session)
        check(actionEpoch == epoch && paymentAction && selected == selectedBaseId() && catalogue() == actionCatalogue && actionsAllowed()) { "The original payment review is no longer active." }
        requireOriginal(q.request.baseId, q); validateRail(q)
        check(mutable.value.enabled && quoteFresh(q)) { "The original payment window ended. Check this saved purchase before continuing." }
    }
    private suspend fun status(key: String, kind: String? = null): BasePurchaseStatus {
        // The older paid-base endpoint ignores unknown query fields. A distinct route proves that
        // the extended quote family exists before saving any new consent.
        val family = when (kind) { "shield", "warzone_shield" -> "shields"; "energy", "energy_pack" -> "energy"; else -> null }
        val raw = bounded { api.get(if (family != null) "$PATH/$family/$key" else "$PATH/$key", if (family != null) mapOf("kind" to requireNotNull(kind)) else emptyMap()) }
        return BasePurchaseStatus.from(raw).also { require(it.wallet == session.wallet && it.key == key) }
    }
    private suspend fun probe(kind: String? = null): Boolean {
        mutable.update { it.copy(supported = false, enabled = false) }
        val s = try { status(UUID.randomUUID().toString(), kind) }
        catch (e: ApiException) { if (e.status == 404) return false else throw e }
        require(s.purchase == null); mutable.update { it.copy(supported = true, enabled = s.enabled) }; return s.enabled
    }
    private suspend fun offer(kind: String, baseId: String, buildingId: String?): BasePurchaseOffer {
        requireOriginal(baseId); val home = bounded { readHome(api, baseId) }
        require(home.base.player.wallet == null || home.base.player.wallet == session.wallet)
        if (kind == "warzone_shield") require((home.base.raw["warzone"] as? JsonObject)?.flag("active") == true) { "A Warzone shield can only be bought during an active Warzone." }
        val offer = requireNotNull(basePurchaseOffer(requireNotNull(catalogue()), home.base, kind, buildingId)) { "The original purchase is unavailable at this base. Refresh its current level, slots and builders." }
        offer.maxCostShards?.let { require(home.balances.shards.toBigInteger() >= it.toBigInteger()) { "The original base needs $it SHARDS for this upgrade." } }
        return offer
    }
    private suspend fun observe(saved: SavedBasePurchase): Boolean {
        if (saved.purchase?.status == "credited") { hydrate(saved); return true }
        val started = monotonicMs(); val s = status(saved.request.key, saved.request.kind)
        mutable.update { it.copy(supported = true, enabled = s.enabled) }
        val p = s.purchase
        if (p == null) { fresh = null; publish(); return false }
        require(p.quote.request == saved.request); validateRail(p.quote)
        val adopted = store.adopt(p)
        if (s.enabled && p.status == "pending" && !adopted.attempted) {
            val remaining = Instant.parse(p.quote.payableUntil).toEpochMilli() - Instant.parse(s.serverNow).toEpochMilli()
            val deadline = Math.addExact(started, remaining)
            fresh = p.quote to minOf(deadline, fresh?.takeIf { it.first == p.quote }?.second ?: deadline)
        } else fresh = null
        publish(adopted); if (p.status == "credited") hydrate(adopted) else retireIfUnpaid(adopted)
        return true
    }
    /** [UnpaidAttempt]: runs on the purchase the GET above just returned. One read-only RPC at most, never a mutation. */
    private suspend fun retireIfUnpaid(saved: SavedBasePurchase) {
        val now = wallClockMs(); val purchase = saved.purchase ?: return
        if (!saved.unpaidAttemptEnded(now)) return
        val landing = saved.signature?.let { signature ->
            // The session is checked again AFTER the verdict arrives and BEFORE anything is cleared, as on the market
            // and deposit rails: a verdict that returns into a replaced session must never clear this store.
            try { bounded { signatureLanding(signature, saved.lastValidBlockHeight) }.also { guard() } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { guard(); return /* Fail closed: the purchase stays saved and a later check asks again. */ }
        }
        // A null status the node cannot yet prove final (it has not finalized past the saved height, or that read
        // failed): nothing retires and a later check asks again. Without a saved height it can never be proven, which
        // [UnpaidAttempt.cleared] refuses below: support.
        if (landing == SignatureLanding.UNPROVEN && saved.lastValidBlockHeight != null) return
        if (!UnpaidAttempt.cleared(saved.signature, landing, saved.lastValidBlockHeight)) { mutable.update { it.copy(paymentFound = true) }; return }
        store.retireUnpaidAttempt(purchase, now, landing); fresh = null; publish(null)
        mutable.update { it.copy(notice = UnpaidAttempt.notice(landing)) }
    }
    suspend fun open(kind: String? = null) = action {
        publish(); val saved = store.read()
        if (saved != null) observe(saved) else probe(kind)
    }
    suspend fun check(kind: String? = null) = action { store.read()?.let { observe(it) } ?: probe(kind) }
    suspend fun review(kind: String, baseId: String, buildingId: String? = null) = action(payment = true) {
        check(store.read() == null) { "Recover the saved purchase first." }; bounded { refreshAccount() }
        check(probe(kind)) { "This purchase is unavailable on this server. No quote or payment was submitted." }
        val offer = offer(kind, baseId, buildingId); reviewCatalogue = actionCatalogue
        mutable.update { it.copy(review = offer, hydrated = false, unavailable = null) }
    }
    suspend fun create(offer: BasePurchaseOffer) = action(payment = true) {
        require(mutable.value.review == offer && reviewCatalogue == catalogue()) { "Review the current offer before requesting its quote." }
        check(store.read() == null); bounded { refreshAccount() }; check(probe(offer.kind)) { "Paid base purchases are paused." }
        require(offer(offer.kind, offer.baseId, offer.buildingId) == offer) { "The canonical purchase offer changed. Review again." }
        val request = offer.request(UUID.randomUUID().toString()); guard(); store.draft(request, offer); publish()
        mutable.update { it.copy(review = null, notice = null) }; quote(request)
    }
    private suspend fun quote(request: BasePurchaseRequest) {
        val started = monotonicMs(); val raw = bounded { api.post("$PATH/quote", request.raw) }
        val s = BasePurchaseStatus.from(raw); require(s.wallet == session.wallet && s.key == request.key)
        val p = requireNotNull(s.purchase); require(p.quote.request == request); validateRail(p.quote)
        val saved = store.adopt(p); mutable.update { it.copy(supported = true, enabled = s.enabled) }
        if (s.enabled && p.status == "pending" && !saved.attempted) {
            fresh = p.quote to Math.addExact(started, Instant.parse(p.quote.payableUntil).toEpochMilli() - Instant.parse(s.serverNow).toEpochMilli())
        }
        publish(saved); if (p.status == "credited") hydrate(saved)
    }
    suspend fun retryQuote() = action(payment = true) {
        val saved = requireNotNull(store.read()); check(saved.purchase == null && !saved.attempted)
        observe(saved); if (store.read()?.purchase != null) return@action
        bounded { refreshAccount() }; requireOriginal(saved.request.baseId)
        check(probe(saved.request.kind)) { "Keep the original draft until quote recovery is available." }
        require(offer(saved.offer.kind, saved.offer.baseId, saved.offer.buildingId) == saved.offer) { "The saved offer changed. Keep its original draft for support." }
        quote(saved.request)
    }
    suspend fun cancelUnquoted() = action {
        val saved = requireNotNull(store.read()); require(saved.purchase == null && !saved.attempted)
        val receipt = BasePurchaseCancellation.from(bounded { api.post("$PATH/${saved.request.key}/cancel-unquoted") })
        require(receipt.wallet == session.wallet && receipt.key == saved.request.key)
        if (receipt.cancelled) {
            store.cancelUnquoted(receipt); fresh = null; publish(null)
        } else {
            val purchase = requireNotNull(receipt.purchase)
            require(purchase.quote.request == saved.request); validateRail(purchase.quote)
            val restored = store.adopt(purchase); publish(restored); observe(restored)
        }
    }
    private suspend fun hydrate(saved: SavedBasePurchase) {
        require(saved.purchase?.status == "credited"); bounded { refreshAccount() }
        val baseId = saved.request.baseId; val dir = requireNotNull(directory()) { "Refresh the original deed directory before finishing." }
        val available = dir.enabled && dir.bases.any { it.id == baseId && it.selectable }
        if (available) {
            bounded { readHome(api, baseId) }; bounded { refreshAccount() }
            require(directory() == dir) { "The original deed changed during refresh. Check again." }
            if (selectedBaseId() == baseId) bounded { refreshSelected() }
        }
        guard(); require(store.read()?.purchase?.receipt == saved.purchase.receipt)
        mutable.update { it.copy(hydrated = true, unavailable = if (available) null else "The original deed is unavailable. This receipt records that deed's purchase; it does not grant anything to your selected base.") }
    }
    private suspend fun reconcileOriginal(saved: SavedBasePurchase) {
        if (saved.purchase?.status == "credited") { hydrate(saved); return }
        // Explicit verification may also expire an unpaid quote after the server's
        // recovery window. GET-only foreground checks never release its reservation.
        val q = requireNotNull(saved.purchase).quote
        // A quote the server ended unpaid can never be credited: no /paid, no /verify, only the GET that lets
        // [retireIfUnpaid] decide.
        if (saved.unpaidEnd) { observe(saved); return }
        if (saved.signature != null) {
            try { bounded { api.post("/deposits/${q.depositId}/paid", jsonBody("signature" to saved.signature)) } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { guard() /* Verify still searches this original reference; it never sends wallet funds. */ }
        }
        bounded { api.post("/deposits/${q.depositId}/verify") }
        observe(requireNotNull(store.read()))
    }
    suspend fun reconcile() = action { store.read()?.let { reconcileOriginal(it) } }
    suspend fun finish() = action {
        var saved = requireNotNull(store.read())
        if (!saved.attempted) { check(observe(saved)) { "The server has not returned the original quote. Keep its saved draft." }; saved = requireNotNull(store.read()) }
        store.finish(saved.request.key, mutable.value.hydrated); fresh = null; publish(null)
    }
    suspend fun pay(sender: BasePurchaseSender) = action(payment = true) {
        var saved = requireNotNull(store.read()); check(!saved.attempted && saved.purchase?.status == "pending") { "Recover this payment; do not send another transfer." }
        bounded { refreshAccount() }; observe(saved); saved = requireNotNull(store.read())
        if (saved.attempted || saved.purchase?.status != "pending") return@action
        val q = requireNotNull(saved.purchase).quote; requirePaymentWindow(q)
        require(offer(saved.offer.kind, saved.offer.baseId, saved.offer.buildingId) == saved.offer) { "The original slot, level or canonical cost changed. Keep the saved quote for recovery." }
        val prepared = bounded { preparePayment(q) }; requirePaymentWindow(q)
        mutable.update { it.copy(feeLamports = prepared.feeLamports.toString()) }; publish(store.attempted(q, wallClockMs(), prepared.lastValidBlockHeight))
        try {
            val signature = sender.send(prepared.transaction, q) { signature -> holder.requireCurrent(session); store.recordSignature(q, signature, wallClockMs()) }
            guard(); publish(store.recordSignature(q, signature, wallClockMs())); reconcileOriginal(requireNotNull(store.read()))
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            holder.requireCurrent(session); publish()
            if (store.read()?.purchase?.status == "credited") throw IOException("The purchase is accepted. Refresh its original deed before finishing.")
            if (e is WalletPaymentException && e.refusedBeforeBroadcast && store.read()?.signature == null) {
                publish(store.refusedBeforeSignature(q)); throw IOException(notSentNotice(e, "The original quote is kept for explicit approval within its payment window."))
            }
            // Uncertain: the wallet could broadcast until this moment, so the retire margin is counted from here.
            store.read()?.takeIf { it.purchase?.quote == q && it.attempted }?.let { publish(store.walletEnded(q, wallClockMs())) }
            stoppedBeforeRelayNotice(e, "Check this original purchase; do not send another transfer.")?.let { throw IOException(it) }
            throw IOException("Payment outcome is uncertain${paymentDetail(e)}. Check this original purchase; do not send another transfer.")
        }
    }
    companion object { const val PATH = "/base/purchases/v1" }
}
