package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*

data class LegacyMarketState(val page: LegacyMarketPage? = null, val after: String? = null,
    val history: MarketTradeHistory? = null, val busy: Boolean = false, val fresh: Boolean = false,
    val pendingError: String? = null, val historyError: String? = null, val notice: String? = null,
    val destination: MarketDestinationRefresh? = null)

/** Recovery is available to the original buyer even after land transfer. Opening or resuming
 * only reads private server history. CHECK is an explicit exact-reference settlement request;
 * there is no payment, wallet, new intent or automatic mutation retry in this repository. */
class LegacyMarketRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val refreshAccount: suspend () -> Unit,
    private val ownedBaseIds: () -> Set<String>?, private val refreshMarket: suspend () -> Unit) {
    private val mutable = MutableStateFlow(LegacyMarketState())
    val state = mutable.asStateFlow()
    private val admission = Mutex()
    private suspend fun guard() { currentCoroutineContext().ensureActive(); holder.requireCurrent(session) }
    private suspend fun action(block: suspend () -> Unit) {
        if (!admission.tryLock()) return
        try { guard(); mutable.update { it.copy(busy = true) }; block() }
        finally { if (holder.isCurrent(session)) mutable.update { it.copy(busy = false) }; admission.unlock() }
    }
    private suspend fun readPage(after: String?) {
        after?.let(MarketContract::id)
        mutable.update { it.copy(after = after, page = it.page.takeIf { _ -> it.after == after }, fresh = false, pendingError = null) }
        try {
            val page = LegacyMarketPage.from(api.get(PENDING, after?.let { mapOf("after" to it) } ?: emptyMap()))
            guard(); check(after == null || page.purchases.all { it.listingId > after }) { "Saved purchase pagination changed." }
            mutable.update { it.copy(page = page, fresh = true) }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { guard(); mutable.update { it.copy(pendingError = e.message ?: "Saved purchases are unavailable.") } }
    }
    private suspend fun readHistory() {
        try {
            val history = MarketTradeHistory.from(api.get(HISTORY)); guard()
            mutable.update { it.copy(history = history, historyError = null) }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { guard(); mutable.update { it.copy(historyError = e.message ?: "Trade history is unavailable.") } }
    }
    suspend fun refresh() = action { readPage(mutable.value.after); readHistory() }
    suspend fun page(after: String?) = action {
        check(after == null || after == mutable.value.page?.next) { "Reload the saved purchases first." }
        readPage(after)
    }
    suspend fun check(purchase: LegacyMarketPurchase) = action {
        mutable.update { it.copy(notice = null, destination = null) }
        try {
            check(mutable.value.fresh && purchase in mutable.value.page?.purchases.orEmpty()) { "Reload this original purchase before checking it." }
            val result = api.post("/market/purchases/${purchase.listingId}/check", buildJsonObject { put("reference", purchase.reference) })
            guard()
            if (!MarketContract.flag(result, "settled")) {
                mutable.update { it.copy(notice = "The original payment is not finalized yet. Check again later; no new payment was requested.") }
                return@action
            }
            check(MarketContract.text(result, "itemId") == purchase.itemId) { "The payment check returned a different item." }
            refreshAccount(); guard()
            val base = purchase.buyerBaseId
            val owned = base == null || base in requireNotNull(ownedBaseIds()) { "Refresh the deed directory to load the original receiving inventory." }
            val inventory = if (!owned) null else {
                val raw = api.get("/items", base?.let { mapOf("baseId" to it) } ?: emptyMap()); guard()
                check(base == null || base in requireNotNull(ownedBaseIds())) { "The receiving deed changed ownership. Check again." }
                Inventory.from(raw)
            }
            refreshMarket(); guard()
            mutable.update { it.copy(destination = MarketDestinationRefresh(base, owned, inventory), notice =
                if (owned) "Payment settled. The item was delivered to the original receiving inventory."
                else "Payment settled to the original receiving deed. Its current inventory is private to its new owner.") }
            readPage(mutable.value.after); readHistory()
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { guard(); mutable.update { it.copy(notice = "${e.message ?: "Payment check unavailable."} Check the original payment again; no new payment was requested.") } }
    }
    companion object {
        const val PENDING = "/market/purchases/pending"
        const val HISTORY = "/market/trades"
    }
}
