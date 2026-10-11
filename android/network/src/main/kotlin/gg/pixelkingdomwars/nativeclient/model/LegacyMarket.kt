package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*

/** Private server-retained observations, never a payable v1 quote or a new reservation. */
data class LegacyMarketPurchase(val listingId: String, val itemId: String, val reference: String,
    val priceLamports: String, val buyerBaseId: String?)
data class LegacyMarketPage(val purchases: List<LegacyMarketPurchase>, val next: String?) {
    companion object { fun from(raw: JsonObject): LegacyMarketPage = with(MarketContract) {
        val rows = requireNotNull(raw["purchases"] as? JsonArray).map { value ->
            val row = requireNotNull(value as? JsonObject)
            LegacyMarketPurchase(id(text(row, "listingId")), item(text(row, "itemId")), address(text(row, "reference")),
                amount(text(row, "priceLamports")), optional(row, "buyerBaseId")?.let(::id))
        }
        require(rows.size <= 50 && rows.map { it.listingId }.distinct().size == rows.size)
        val next = optional(raw, "next")?.let(::id)
        require(next == null || next == rows.lastOrNull()?.listingId)
        LegacyMarketPage(rows, next)
    } }
}
data class MarketCompletedTrade(val listingId: String, val itemId: String, val role: String,
    val priceLamports: String, val buyerBaseId: String?, val txSignature: String, val settledAt: String?)
data class MarketTradeHistory(val trades: List<MarketCompletedTrade>, val hasMore: Boolean) {
    companion object { fun from(raw: JsonObject): MarketTradeHistory = with(MarketContract) {
        val rows = requireNotNull(raw["trades"] as? JsonArray).map { value ->
            val row = requireNotNull(value as? JsonObject)
            MarketCompletedTrade(id(text(row, "listingId")), item(text(row, "itemId")),
                text(row, "role").also { require(it in setOf("bought", "sold")) }, amount(text(row, "priceLamports")),
                optional(row, "buyerBaseId")?.let(::id), signature(text(row, "txSignature")), optional(row, "settledAt")?.let(::date))
        }
        require(rows.size <= 50 && rows.map { it.listingId }.distinct().size == rows.size)
        MarketTradeHistory(rows, flag(raw, "hasMore"))
    } }
}
