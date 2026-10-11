package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.net.URI

enum class ExternalMarket(val label: String) { TENSOR("Tensor"), MAGIC_EDEN("Magic Eden") }
data class MarketBrowseState(val query: MarketQuery = MarketQuery(), val book: MarketBook? = null,
    val own: List<OwnMarketListing>? = null, val collection: CoreMarketCollection? = null, val assets: CoreMarketAssets? = null,
    val loading: Boolean = false, val fresh: Set<String> = emptySet(), val errors: Map<String, String> = emptyMap())

/** Same canonical external destinations as shared constants.ts. Exact target/id matching prevents
 * a server-returned browse URL from becoming arbitrary browser navigation. */
data class MarketDestinations(val tensor: String, val magicEden: String) {
    fun validate(links: MarketLinks, id: String, collection: Boolean) {
        check(links.tensor == "$tensor/${if (collection) "trade" else "item"}/$id" &&
            links.magicEden == "$magicEden/${if (collection) "marketplace" else "item-details"}/$id") { "Marketplace links require a game content update." }
    }
    companion object { fun from(catalogue: JsonObject?): MarketDestinations? = runCatching {
        val c = requireNotNull((catalogue?.get("constants") as? JsonObject)?.get("MARKETPLACE") as? JsonObject)
        fun base(key: String) = requireNotNull(c.string(key)).also { raw ->
            val u = URI(raw); require(u.scheme == "https" && !u.host.isNullOrBlank() && u.port == -1 && u.rawPath.isNullOrEmpty() && u.rawUserInfo == null && u.rawQuery == null && u.rawFragment == null)
        }
        MarketDestinations(base("tensorBase"), base("magicEdenBase"))
    }.getOrNull() }
}

/** Read-only marketplace. The book and own-listings DTOs are observations, never command receipts. */
class MarketRepository(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val api: ApiClient, private val destinations: () -> MarketDestinations?) {
    private val mutable = MutableStateFlow(MarketBrowseState())
    val state = mutable.asStateFlow()
    private var generation = 0
    fun requireCurrent() = holder.requireCurrent(session)
    private suspend fun current() { currentCoroutineContext().ensureActive(); requireCurrent() }

    suspend fun refresh(query: MarketQuery = mutable.value.query) {
        current(); val capture = ++generation
        mutable.update { it.copy(query = query, loading = true, fresh = emptySet(), errors = emptyMap(), book = it.book.takeIf { _ -> it.query == query }) }
        suspend fun read(path: String, parameters: Map<String, String> = emptyMap(), parse: (MarketBrowseState, JsonObject) -> MarketBrowseState) {
            try {
                val raw = api.get(path, parameters); current()
                if (generation == capture) mutable.value = parse(mutable.value, raw).let { it.copy(fresh = it.fresh + path, errors = it.errors - path) }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { current(); if (generation == capture) mutable.update { it.copy(errors = it.errors + (path to (e.message ?: "Market data is unavailable."))) } }
        }
        try {
            read(BOOK, query.parameters()) { s, raw ->
                val book = MarketBook.from(raw)
                check(query.itemId == null || book.offers.all { it.itemId == query.itemId }) { "The market returned a different item filter." }
                s.copy(book = book)
            }
            if (generation != capture) return
            read(OWN) { s, raw -> s.copy(own = OwnMarketListing.list(raw)) }
            read(COLLECTION) { s, raw -> s.copy(collection = CoreMarketCollection.from(raw)) }
            read(ASSETS) { s, raw -> s.copy(assets = CoreMarketAssets.from(raw)) }
        } finally { if (holder.isCurrent(session) && generation == capture) mutable.update { it.copy(loading = false) } }
    }

    /** Re-read the trading gate and asset frozen state immediately before opening an external market.
     * Missing/newly frozen assets, offline reads and changed identity never reuse previously enabled links. */
    suspend fun externalLink(market: ExternalMarket, assetId: String? = null): String {
        current()
        val target = requireNotNull(destinations()) { "External marketplace links need current game content." }
        val collection = CoreMarketCollection.from(api.get(COLLECTION)); current()
        check(collection.tradingEnabled) { "Core assets remain soulbound. Trading has not opened." }
        val links = if (assetId == null) {
            requireNotNull(collection.links).also { target.validate(it, requireNotNull(collection.collection), collection = true) }
        } else {
            val assets = CoreMarketAssets.from(api.get(ASSETS)); current()
            check(assets.tradingEnabled) { "Asset trading has not opened." }
            val asset = assets.assets.singleOrNull { it.id == assetId } ?: error("This asset is no longer returned for your wallet. Refresh the collection.")
            check(!asset.frozen) { "This asset is soulbound." }
            target.validate(asset.links, asset.id, collection = false); asset.links
        }
        current()
        return if (market == ExternalMarket.TENSOR) links.tensor else links.magicEden
    }
    companion object {
        const val BOOK = "/market/listings"
        const val OWN = "/market/listings/mine"
        const val COLLECTION = "/market/collection"
        const val ASSETS = "/market/assets"
    }
}
