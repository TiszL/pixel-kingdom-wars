package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.jsonBody
import gg.pixelkingdomwars.nativeclient.ops.*
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

sealed interface MarketReview {
    val wallet: String
    data class Listing(override val wallet: String, val baseId: String?, val itemId: String, val priceLamports: String) : MarketReview
    data class Purchase(override val wallet: String, val buyerBaseId: String?, val offer: MarketOffer) : MarketReview
    data class Cancellation(override val wallet: String, val consent: MarketCancelConsent) : MarketReview
}
data class MarketTradeState(val supported: Boolean = false, val loaded: Boolean = false, val busy: Boolean = false,
    val error: String? = null, val notice: String? = null, val review: MarketReview? = null,
    val own: List<MarketCancelConsent> = emptyList(), val inventory: Inventory? = null, val inventoryBaseId: String? = null,
    val saved: SavedMarketPurchase? = null, val quoteFresh: Boolean = false, val hydrated: Boolean = false,
    val pending: List<PendingIntent> = emptyList(), val feeLamports: String? = null,
    val destinationRefresh: MarketDestinationRefresh? = null,
    /** The server ended the saved purchase unpaid, yet the cluster knows its recorded signature — or answers null for
     * one saved without the block height that could prove the null final: support, never retired. */
    val paymentFound: Boolean = false,
    /** The saved commands that still refuse a new one of their kind (owner 2026-10-06: a refused retry stops blocking). */
    val blocking: List<PendingIntent> = emptyList()) {
    val canPay get() = loaded && supported && !busy && quoteFresh && saved != null && !saved.attempted &&
        saved.receipt.state == "reserved" && blocking.none { it.kind == IntentKind.MARKET_RESERVE }
}
/** The receipt proves delivery; this only records whether its original destination could be refreshed. */
data class MarketDestinationRefresh(val baseId: String?, val stillOwned: Boolean, val inventory: Inventory?)

/** Commands recover by their immutable key. A signed purchase recovers only its original reservation;
 * current inventory, balances and listings are never proof of acceptance or payment. */
class MarketTransactionsRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, intents: PendingIntentStore, private val observer: ReceiptObserver,
    private val store: MarketPurchaseStore, private val cluster: SolanaCluster,
    private val selectedBaseId: () -> String?, private val landOwned: () -> Boolean,
    private val bounds: () -> MarketTradeBounds?, private val preparePayment: suspend (MarketQuote) -> PreparedMarketPurchase,
    private val refreshAccount: suspend () -> Unit, private val refreshMarket: suspend () -> Unit,
    /** Read after refreshAccount has refreshed the authoritative deed directory. Null is unavailable. */
    private val ownedBaseIds: () -> Set<String>?,
    /** Android elapsedRealtime includes device sleep; no process-local deadline is persisted. */
    private val monotonicMs: () -> Long,
    /** Read-only cluster verdict on a recorded signature and the last-valid block height saved with its payment
     * ([UnpaidAttempt]). Unavailable fails closed: nothing retires. */
    private val signatureLanding: suspend (String, Long?) -> SignatureLanding = { _, _ -> throw IOException("Signature status is unavailable.") },
    /** Wall clock: the persisted start of a wallet attempt must survive process death and reboot. */
    private val wallClockMs: () -> Long = System::currentTimeMillis,
) {
    val legacy = LegacyMarketRepository(session, holder, api, refreshAccount, ownedBaseIds, refreshMarket)
    private val mutable = MutableStateFlow(MarketTradeState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    private var fresh: Pair<MarketQuote, Long>? = null
    private val transport = object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject { guard(); return bounded { api.get(path, query) }.also { guard() } }
        override suspend fun post(path: String, body: JsonObject): JsonObject { guard(); return bounded { api.post(path, body) }.also { guard() } }
    }
    private val listing = MoneyOp(MarketListSpec, intents, transport)
    private val reservation = MoneyOp(MarketReserveSpec, intents, transport)
    private val cancellation = MoneyOp(MarketCancelSpec, intents, transport)
    init {
        observer.register(listing) { hydrateListing(it.value) }
        observer.register(reservation) { accepted ->
            guard(); publish(store.adopt(accepted.value)); hydrate()
        }
        observer.register(cancellation) { hydrateCancellation(it.value) }
    }
    private suspend fun guard() { currentCoroutineContext().ensureActive(); holder.requireCurrent(session) }
    private fun currentBase(base: String?) {
        holder.requireCurrent(session)
        check(base == null || base == selectedBaseId()) { "The selected base changed. Review this action again." }
    }
    private fun limits() = requireNotNull(bounds()) { "Market payments need current game content." }
    private suspend fun <T> bounded(block: suspend () -> T): T = try { withTimeout(limits().timeoutMs) { block() } }
        catch (_: TimeoutCancellationException) { throw IOException("Market request timed out. Saved requests and payments are kept.") }
    private fun pending() = listOfNotNull(listing.pending(session.wallet), reservation.pending(session.wallet), cancellation.pending(session.wallet))
    private fun blocking() = listOfNotNull(listing.blocking(session.wallet), reservation.blocking(session.wallet), cancellation.blocking(session.wallet))
    private fun publish(saved: SavedMarketPurchase? = store.read()) {
        holder.requireCurrent(session)
        mutable.update { it.copy(saved = saved, loaded = true, pending = pending(), blocking = blocking(), quoteFresh = saved?.quote?.let(::quoteFresh) == true,
            hydrated = it.hydrated && it.saved?.quote == saved?.quote && it.saved?.receipt == saved?.receipt,
            paymentFound = it.paymentFound && saved?.unpaidEnd == true && it.saved?.quote == saved.quote) }
    }
    private suspend fun action(block: suspend () -> Unit) {
        if (!admission.tryLock()) return
        try { guard(); mutable.update { it.copy(busy = true, error = null) }; block() }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { guard(); mutable.update { it.copy(error = e.message ?: "Market action interrupted. Check its saved status.") } }
        finally { try {
            if (holder.isCurrent(session)) {
                try { publish(); observer.refresh(session.wallet) }
                catch (e: CancellationException) { throw e }
                catch (_: Exception) { mutable.update { it.copy(error = "The saved market journal could not be refreshed. Reconnect before continuing.") } }
                finally { mutable.update { it.copy(busy = false) } }
            }
        } finally { admission.unlock() } }
    }
    private suspend fun feature(): MarketBook {
        mutable.update { it.copy(supported = false) }
        val raw = bounded { api.get(MarketRepository.BOOK) }; guard()
        val book = MarketBook.from(raw)
        mutable.update { it.copy(supported = MarketContract.supported(raw)) }
        return book
    }
    private suspend fun newCommand(): MarketBook {
        val book = feature(); check(mutable.value.supported) { "Trading needs the marketplace server update. Browsing remains available." }
        check(landOwned()) { "A Land Deed is required to trade items." }
        return book
    }
    private suspend fun own() {
        val raw = bounded { api.get(OWN) }; guard()
        val rows = MarketCancelConsent.list(raw)
        mutable.update { it.copy(own = rows) }
    }
    private suspend fun inventory() {
        val base = selectedBaseId()
        mutable.update { it.copy(inventory = null, inventoryBaseId = null) }
        // Landless historical recovery must not query another owner's former deed inventory.
        if (!landOwned()) return
        val value = Inventory.from(bounded { api.get("/items", base?.let { mapOf("baseId" to it) } ?: emptyMap()) })
        guard(); check(base == selectedBaseId()) { "The selected base changed while refreshing inventory." }
        mutable.update { it.copy(inventory = value, inventoryBaseId = base) }
    }
    private suspend fun hydrate() {
        refreshAccount(); guard(); inventory(); refreshMarket(); guard()
        val saved = store.read()
        if (saved?.receipt?.state == "settled") {
            val base = saved.quote.buyerBaseId
            val owned = base == null || base in requireNotNull(ownedBaseIds()) { "Refresh the deed directory before finishing this purchase." }
            val original = if (!owned) null else {
                val raw = bounded { api.get("/items", base?.let { mapOf("baseId" to it) } ?: emptyMap()) }; guard()
                check(base == null || base in requireNotNull(ownedBaseIds())) { "The receiving deed changed ownership while refreshing. Check again." }
                Inventory.from(raw)
            }
            guard(); check(store.read()?.quote == saved.quote)
            mutable.update { it.copy(hydrated = true, destinationRefresh = MarketDestinationRefresh(base, owned, original)) }
        }
    }
    private suspend fun hydrateListing(receipt: MarketListingReceipt) {
        // Player copy only: the item art and name are on the listing row; ids stay under its DETAILS.
        hydrate(); mutable.update { it.copy(notice = "LISTED FOR ${marketSol(receipt.priceLamports)} SOL.") }
    }
    private suspend fun hydrateCancellation(receipt: MarketCancellationReceipt) {
        hydrate(); mutable.update { it.copy(notice = when (receipt.state) {
            "settled" -> "A buyer's purchase settled first — the item sold and the sale stands."
            "refused" -> "Cancellation was refused: ${receipt.refusalCode}. Check the listing and try again."
            else -> "Listing cancelled — the item went back to the kingdom it was listed from."
        }) }
    }
    suspend fun open() = action {
        publish()
        // Receipt recovery remains available after deed transfer and independent of today's feature gate.
        for (saved in pending()) observer.check(saved.kind, session.wallet)
        publish()
        store.read()?.let { if (it.receipt.state == "settled") hydrate() else observePurchase(it) }
        feature()
        if (mutable.value.supported) { own(); inventory() }
    }
    fun dismissReview() { holder.requireCurrent(session); mutable.update { it.copy(review = null) } }
    suspend fun reviewListing(itemId: String, solPrice: String) = action {
        newCommand(); inventory()
        val items = requireNotNull(mutable.value.inventory)
        val item = requireNotNull(items.item(itemId)) { "This item is no longer in the server catalogue." }
        check(!item.dropOnly && items.stored(itemId) > 0) { "Only an unequipped, tradable stored item can be listed." }
        val base = if (item.kind == "cosmetic") null else selectedBaseId()
        check(item.kind == "cosmetic" || base != null) { "Select the item's base first." }
        mutable.update { it.copy(review = MarketReview.Listing(session.wallet, base, itemId, limits().price(solPrice))) }
    }
    suspend fun reviewPurchase(offer: MarketOffer) = action {
        val book = newCommand()
        check(book.offers.any { it == offer }) { "This offer changed. Refresh and review its current terms." }
        check(offer.seller != session.wallet) { "This listing belongs to your wallet." }
        val base = if (offer.baseId == null) null else requireNotNull(selectedBaseId()) { "Select the receiving base." }
        mutable.update { it.copy(review = MarketReview.Purchase(session.wallet, base, offer)) }
    }
    suspend fun reviewCancellation(listingId: String) = action {
        newCommand(); own()
        val consent = mutable.value.own.single { it.listing.id == listingId }
        mutable.update { it.copy(review = MarketReview.Cancellation(session.wallet, consent)) }
    }
    suspend fun confirm(review: MarketReview) = action {
        check(mutable.value.review == review && review.wallet == session.wallet) { "Review the current action before confirming." }
        newCommand()
        val intent = when (review) {
            is MarketReview.Listing -> { currentBase(review.baseId); MarketListSpec.intent(session.wallet, review.baseId, UUID.randomUUID().toString(), review.itemId, review.priceLamports) }
            is MarketReview.Purchase -> {
                currentBase(review.buyerBaseId); check(store.read() == null) { "Finish the saved purchase first." }
                MarketReserveSpec.intent(session.wallet, review.buyerBaseId, UUID.randomUUID().toString(), review.offer)
            }
            is MarketReview.Cancellation -> MarketCancelSpec.intent(session.wallet, UUID.randomUUID().toString(), review.consent)
        }
        mutable.update { it.copy(review = null, notice = null) }
        when (review) {
            is MarketReview.Listing -> listing.submit(intent) { hydrateListing(it.value) }
            is MarketReview.Purchase -> reservation.submit(intent) { guard(); publish(store.adopt(it.value)); hydrate() }
            is MarketReview.Cancellation -> cancellation.submit(intent) { hydrateCancellation(it.value) }
        }
    }
    suspend fun checkCommand(kind: String, retry: Boolean = false) = action {
        require(kind in KINDS)
        // Explicit retry replays the stored body/key even after selection changes. The server decides
        // whether an old command was admitted; this never authorizes a newly reconstructed command.
        if (retry) observer.retry(kind, session.wallet) else observer.check(kind, session.wallet)
    }
    private fun quoteFresh(quote: MarketQuote) = fresh?.let { (q, deadline) -> q == quote && monotonicMs() < deadline } == true
    fun requirePaymentWindow(quote: MarketQuote) {
        holder.requireCurrent(session); currentBase(quote.buyerBaseId)
        check(quote.buyer == session.wallet && quote.cluster == cluster.id && landOwned()) { "Reconnect the quoted wallet and receiving base before payment." }
        check(reservation.blocking(session.wallet) == null && quoteFresh(quote)) { "The payment window ended. Check the original reservation before continuing." }
    }
    private suspend fun observePurchase(saved: SavedMarketPurchase) {
        val started = monotonicMs(); fresh = null
        val raw = bounded { api.get("/market/v1/reservations/by-key/${requireNotNull(saved.quote.key)}") }; guard()
        val receipt = MarketReservationReceipt.from(raw)
        val adopted = store.adopt(receipt)
        if (receipt.payable && !adopted.attempted) {
            val remaining = Instant.parse(receipt.quote.payableUntil).toEpochMilli() - Instant.parse(receipt.serverNow).toEpochMilli()
            fresh = receipt.quote to Math.addExact(started, remaining)
        }
        publish(adopted)
        if (receipt.state == "settled") hydrate() else retireIfUnpaid(adopted)
    }
    /** [UnpaidAttempt]: runs on the receipt the GET above just returned. One read-only RPC at most, never a mutation. */
    private suspend fun retireIfUnpaid(saved: SavedMarketPurchase) {
        val now = wallClockMs()
        if (!saved.unpaidAttemptEnded(now)) return
        val landing = saved.signature?.let { signature ->
            try { bounded { signatureLanding(signature, saved.lastValidBlockHeight) }.also { guard() } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { guard(); return /* Fail closed: the purchase stays saved and a later poll asks again. */ }
        }
        // A null status the node cannot yet prove final (it has not finalized past the saved height, or that read
        // failed): nothing retires and a later poll asks again. Without a saved height it can never be proven, which
        // [UnpaidAttempt.cleared] refuses below: support.
        if (landing == SignatureLanding.UNPROVEN && saved.lastValidBlockHeight != null) return
        if (!UnpaidAttempt.cleared(saved.signature, landing, saved.lastValidBlockHeight)) { mutable.update { it.copy(paymentFound = true) }; return }
        store.retireUnpaidAttempt(saved.receipt, now, landing); fresh = null; publish(null)
        mutable.update { it.copy(notice = UnpaidAttempt.notice(landing)) }
    }
    private suspend fun reconcilePayment(saved: SavedMarketPurchase) {
        if (saved.receipt.state == "settled") { hydrate(); return }
        if (!saved.attempted) { observePurchase(saved); return }
        if (saved.unpaidEnd && !mutable.value.paymentFound) {
            // A reservation the server ended unpaid can never settle: no /paid, no /settle. Once the attempt is past
            // the margin by the device clock, one GET re-reads its receipt — whose fresh server clock is the second
            // half of the margin — and [retireIfUnpaid] decides; before that there is nothing to ask.
            // A signature the cluster DOES know stays on the path below: its /paid is how the server hears of a late payment.
            if (saved.unpaidAttemptDue(wallClockMs())) observePurchase(saved)
            return
        }
        val q = saved.quote
        if (saved.signature != null) {
            try {
                val raw = bounded { api.post("/market/v1/reservations/${q.reservationId}/paid", jsonBody("reference" to q.reference, "signature" to saved.signature)) }
                guard(); publish(store.adopt(MarketReservationReceipt.from(raw)))
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { guard() /* Exact-reference settle can still recover a broadcast without /paid. */ }
        }
        if (store.read()?.receipt?.state != "settled") {
            val raw = bounded { api.post("/market/v1/reservations/${q.reservationId}/settle", buildJsonObject {
                put("reference", q.reference); saved.signature?.let { put("signature", it) }
            }) }; guard(); publish(store.adopt(MarketReservationReceipt.from(raw)))
        }
        val latest = store.read()
        // The /paid or /settle reply may itself be the server's unpaid end of this reservation.
        if (latest?.receipt?.state == "settled") hydrate() else if (latest != null) retireIfUnpaid(latest)
    }
    suspend fun checkPayment() = action { store.read()?.let { reconcilePayment(it) } }
    suspend fun closePurchase() = action {
        check(reservation.blocking(session.wallet) == null) { "Refresh the saved reservation receipt first." }
        var saved = requireNotNull(store.read())
        if (!saved.attempted) { observePurchase(saved); saved = requireNotNull(store.read()) }
        store.close(saved.quote, mutable.value.hydrated); fresh = null; publish(null)
    }
    suspend fun pay(sender: MarketPurchaseSender) = action {
        newCommand()
        var saved = requireNotNull(store.read()) { "Review and reserve an item first." }
        check(!saved.attempted && saved.receipt.state == "reserved") { "Check the saved payment; never send another transfer." }
        observePurchase(saved); saved = requireNotNull(store.read())
        if (saved.attempted || saved.receipt.state != "reserved") return@action
        val q = saved.quote; requirePaymentWindow(q)
        val prepared = bounded { preparePayment(q) }; guard(); requirePaymentWindow(q)
        mutable.update { it.copy(feeLamports = prepared.feeLamports.toString()) }
        publish(store.attempted(q, wallClockMs(), prepared.lastValidBlockHeight))
        try {
            val signature = sender.send(prepared.transaction, q) { signature ->
                holder.requireCurrent(session); store.recordSignature(q, signature, wallClockMs())
            }
            guard(); publish(store.recordSignature(q, signature, wallClockMs())); reconcilePayment(requireNotNull(store.read()))
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            guard(); publish()
            if (store.read()?.receipt?.state == "settled") throw IOException("Your purchase settled. Refresh account and inventory before finishing.")
            if (e is WalletPaymentException && e.refusedBeforeBroadcast && store.read()?.signature == null) {
                publish(store.refusedBeforeSignature(q))
                throw IOException(notSentNotice(e, "Review the reservation before approving again."))
            }
            // Uncertain: the wallet could broadcast until this moment, so the retire margin is counted from here.
            store.read()?.takeIf { it.quote == q && it.attempted }?.let { publish(store.walletEnded(q, wallClockMs())) }
            stoppedBeforeRelayNotice(e, "Check this saved purchase; do not send another transfer.")?.let { throw IOException(it) }
            throw IOException("Payment outcome is uncertain${paymentDetail(e)}. Check this saved purchase; do not send another transfer.")
        }
    }
    companion object {
        const val OWN = "/market/v1/listings/mine"
        val KINDS = setOf(IntentKind.MARKET_LIST, IntentKind.MARKET_RESERVE, IntentKind.MARKET_CANCEL)
    }
}
