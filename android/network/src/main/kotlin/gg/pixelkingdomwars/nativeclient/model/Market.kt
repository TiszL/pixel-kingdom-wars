package gg.pixelkingdomwars.nativeclient.model

import java.math.BigDecimal
import java.math.BigInteger
import java.net.URI
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.*

/** Curated browse DTOs from canonical game/market.ts and game/itemMarket.ts. Never purchase receipts. */
private fun JsonObject.marketText(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun JsonObject.marketOptional(key: String) = if (get(key) == JsonNull) null else marketText(key)
private fun JsonObject.marketRows(key: String) = requireNotNull(get(key) as? JsonArray).map { requireNotNull(it as? JsonObject) }
private fun JsonObject.marketFlag(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull)
private fun JsonObject.marketInt(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull).also { require(it >= 0) }
private fun marketId(value: String) = value.also { require(UUID.fromString(it).toString() == it) }
private fun marketAddress(value: String) = value.also { require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))) }
private fun marketItem(value: String) = value.also { require(it.isNotBlank() && it.length <= 64) }
private fun JsonObject.marketAmount(key: String) = marketText(key).also {
    require(it.length <= 19 && it.matches(Regex("[1-9][0-9]*")) && BigInteger(it).bitLength() <= 63)
}
private fun JsonObject.marketBps() = marketInt("feeBps").also { require(it <= 10_000) }
private fun <T> unique(values: List<T>, identity: (T) -> String) = values.also { require(it.map(identity).distinct().size == it.size) }

/** URLs stay public HTTPS documents: no custom schemes, userinfo, query tokens or fragments. */
data class MarketLinks(val tensor: String, val magicEden: String) {
    companion object { fun from(raw: JsonObject): MarketLinks {
        fun url(key: String) = raw.marketText(key).also {
            val u = URI(it)
            require(u.scheme == "https" && !u.host.isNullOrBlank() && u.rawUserInfo == null && u.port == -1 && u.rawQuery == null && u.rawFragment == null)
        }
        return MarketLinks(url("tensor"), url("magicEden"))
    } }
}
data class CoreMarketCollection(val collection: String?, val royaltyBps: Int, val tradingEnabled: Boolean, val links: MarketLinks?) {
    companion object { fun from(raw: JsonObject): CoreMarketCollection {
        val collection = raw.marketOptional("collection")?.let(::marketAddress)
        val links = if (raw["links"] == JsonNull) null else MarketLinks.from(requireNotNull(raw["links"] as? JsonObject))
        require((collection == null) == (links == null))
        return CoreMarketCollection(collection, raw.marketBps(), raw.marketFlag("tradingEnabled"), links)
    } }
}
data class CoreMarketAsset(val id: String, val name: String, val image: String?, val frozen: Boolean, val kind: String, val links: MarketLinks)
data class CoreMarketAssets(val assets: List<CoreMarketAsset>, val dasConfigured: Boolean, val tradingEnabled: Boolean) {
    companion object { fun from(raw: JsonObject) = CoreMarketAssets(unique(raw.marketRows("assets").map { row ->
        val kind = row.marketText("kind").also { require(it in setOf("deed", "cosmetic")) }
        CoreMarketAsset(marketAddress(row.marketText("id")), row.marketText("name"), row.marketOptional("image"), row.marketFlag("frozen"), kind,
            MarketLinks.from(requireNotNull(row["links"] as? JsonObject)))
    }) { it.id }, raw.marketFlag("dasConfigured"), raw.marketFlag("tradingEnabled")) }
}
enum class MarketSort(val wire: String, val label: String) { FLOOR("floor", "Price ↑"), PRICE_DESC("price_desc", "Price ↓"), NEWEST("newest", "Newest") }
data class MarketQuery(val itemId: String? = null, val sort: MarketSort = MarketSort.FLOOR) {
    init { itemId?.let(::marketItem) }
    fun parameters() = buildMap { itemId?.let { put("itemId", it) }; put("sort", sort.wire) }
}
data class MarketOffer(val id: String, val seller: String, val baseId: String?, val itemId: String, val priceLamports: String, val createdAt: String)
data class MarketFloor(val itemId: String, val floorLamports: String, val listed: Int)
data class MarketBook(val feeBps: Int, val offers: List<MarketOffer>, val summary: List<MarketFloor>) {
    companion object { fun from(raw: JsonObject): MarketBook {
        val offers = unique(raw.marketRows("listings").map { row -> MarketOffer(marketId(row.marketText("id")), marketAddress(row.marketText("seller")),
            row.marketOptional("baseId")?.let(::marketId), marketItem(row.marketText("itemId")), row.marketAmount("priceLamports"), row.marketText("createdAt").also(Instant::parse)) }) { it.id }
        val summary = unique(raw.marketRows("summary").map { row -> MarketFloor(marketItem(row.marketText("itemId")), row.marketAmount("floorLamports"), row.marketInt("listed").also { require(it > 0) }) }) { it.itemId }
        return MarketBook(raw.marketBps(), offers, summary)
    } }
}
data class OwnMarketListing(val id: String, val itemId: String, val baseId: String?, val priceLamports: String, val status: String) {
    companion object { fun list(raw: JsonObject) = unique(raw.marketRows("listings").map { row ->
        OwnMarketListing(marketId(row.marketText("id")), marketItem(row.marketText("itemId")), row.marketOptional("baseId")?.let(::marketId),
            row.marketAmount("priceLamports"), row.marketText("status").also { require(it in setOf("active", "reserved")) })
    }) { it.id } }
}

/** Exact unit conversions for display, retaining tiny offers that a four-decimal label would round away. */
fun marketSol(lamports: String): String = BigDecimal(lamports).movePointLeft(9).stripTrailingZeros().toPlainString()
fun marketPercent(bps: Int): String = BigDecimal(bps).movePointLeft(2).stripTrailingZeros().toPlainString()
