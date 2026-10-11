package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*

private fun JsonObject.tradeText(key: String) = MarketContract.text(this, key)
private fun JsonObject.tradeOptional(key: String) = MarketContract.optional(this, key)
private fun nullable(value: String?): JsonElement = value?.let(::JsonPrimitive) ?: JsonNull

/** Canonical UUID commands with exact-body GET recovery. Missing receipts never prove refusal. */
abstract class MarketSpec<T>(override val kind: String, private val lookup: String) : MoneyOpSpec<T> {
    /** The by-key read answers 404 for a key it does not hold, which cannot be told from a missing route, and `pending` is a
     * live record, not an absent one: only TRY AGAIN (replayed by key) resolves it, and a definitive refusal of that retry
     * stops it refusing a new market order (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.PARK_AFTER_RETRY_REFUSED
    /** Listing, reserving and cancelling move no money (payment is a separate signed step and the server refuses a second
     * listing of an escrowed item): once settled and checked, a request the by-key read cannot answer stops blocking. */
    override fun unblocksAfterCheck(intent: PendingIntent, answer: Receipt<*>) = true
    protected abstract fun result(intent: PendingIntent, response: JsonObject): T
    protected open fun terminal(value: T): Boolean = true
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest {
        MarketContract.id(intent.idempotencyKey)
        return ReceiptRequest(lookup + intent.idempotencyKey, emptyMap())
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<T> = try {
        require(intent.kind == kind)
        val value = result(intent, response)
        if (terminal(value)) Receipt.Accepted(value, ReceiptDocument.fromReceiptRoute(response)) else Receipt.Unknown
    } catch (_: Exception) { throw ApiCompatibilityException(receiptRequest(intent).path) }
    override fun acknowledge(intent: PendingIntent, response: JsonObject): T =
        (decodeReceipt(intent, response) as? Receipt.Accepted)?.value ?: throw ApiCompatibilityException(intent.path)
    override fun restore(intent: PendingIntent, document: JsonObject): T {
        require(ReceiptDocument.source(document) in setOf(ReceiptDocument.SOURCE_POST, ReceiptDocument.SOURCE_RECEIPT))
        return acknowledge(intent, ReceiptDocument.payload(document))
    }
}

object MarketListSpec : MarketSpec<MarketListingReceipt>(IntentKind.MARKET_LIST, "/market/v1/list/by-key/") {
    const val PATH = "/market/v1/list"
    fun intent(wallet: String, base: String?, key: String, item: String, price: String): PendingIntent {
        MarketContract.address(wallet); base?.let(MarketContract::id); MarketContract.id(key)
        MarketContract.item(item); MarketContract.amount(price)
        return PendingIntent(kind, wallet, base, key, PATH, buildJsonObject {
            put("idempotencyKey", key); put("baseId", nullable(base)); put("itemId", item); put("priceLamports", price)
        }, "List item for SOL")
    }
    override fun result(intent: PendingIntent, response: JsonObject): MarketListingReceipt {
        val expected = this.intent(intent.wallet, intent.baseId, intent.idempotencyKey, intent.body.tradeText("itemId"), intent.body.tradeText("priceLamports"))
        require(intent.path == PATH && intent.body == expected.body)
        return MarketListingReceipt.from(response).also {
            require(it.key == intent.idempotencyKey && it.creator == intent.wallet && it.sourceBaseId == intent.baseId &&
                it.itemId == intent.body.tradeText("itemId") && it.priceLamports == intent.body.tradeText("priceLamports"))
        }
    }
}

object MarketReserveSpec : MarketSpec<MarketReservationReceipt>(IntentKind.MARKET_RESERVE, "/market/v1/reservations/by-key/") {
    fun intent(wallet: String, buyerBase: String?, key: String, offer: MarketOffer): PendingIntent {
        MarketContract.address(wallet); buyerBase?.let(MarketContract::id); MarketContract.id(key); MarketContract.id(offer.id)
        offer.baseId?.let(MarketContract::id); MarketContract.address(offer.seller); MarketContract.item(offer.itemId); MarketContract.amount(offer.priceLamports)
        require(offer.seller != wallet && (offer.baseId == null) == (buyerBase == null))
        return PendingIntent(kind, wallet, buyerBase, key, "/market/v1/listings/" + offer.id + "/reserve", buildJsonObject {
            put("idempotencyKey", key); put("buyerBaseId", nullable(buyerBase)); put("sourceBaseId", nullable(offer.baseId))
            put("seller", offer.seller); put("itemId", offer.itemId); put("priceLamports", offer.priceLamports)
        }, "Reserve item purchase", quote = buildJsonObject { put("listingId", offer.id) })
    }
    override fun result(intent: PendingIntent, response: JsonObject): MarketReservationReceipt {
        val listingId = requireNotNull(intent.quote).tradeText("listingId")
        val offer = MarketOffer(listingId, intent.body.tradeText("seller"), intent.body.tradeOptional("sourceBaseId"),
            intent.body.tradeText("itemId"), intent.body.tradeText("priceLamports"), "")
        val expected = this.intent(intent.wallet, intent.baseId, intent.idempotencyKey, offer)
        require(intent.path == expected.path && intent.body == expected.body && intent.quote == expected.quote)
        return MarketReservationReceipt.from(response).also { r ->
            val q = r.quote
            require(q.key == intent.idempotencyKey && q.listingId == listingId && q.buyer == intent.wallet && q.buyerBaseId == intent.baseId &&
                q.sourceBaseId == offer.baseId && q.seller == offer.seller && q.itemId == offer.itemId && q.priceLamports == offer.priceLamports)
        }
    }
}

object MarketCancelSpec : MarketSpec<MarketCancellationReceipt>(IntentKind.MARKET_CANCEL, "/market/v1/cancellations/by-key/") {
    fun intent(wallet: String, key: String, consent: MarketCancelConsent): PendingIntent {
        val listing = consent.listing
        MarketContract.address(wallet); MarketContract.id(key); MarketContract.id(listing.id); listing.baseId?.let(MarketContract::id)
        MarketContract.item(listing.itemId); MarketContract.amount(listing.priceLamports); consent.reference?.let(MarketContract::address)
        require(listing.status in setOf("active", "reserved") && (listing.status == "active") == (consent.reference == null))
        return PendingIntent(kind, wallet, listing.baseId, key, "/market/v1/listings/" + listing.id + "/cancel", buildJsonObject {
            put("idempotencyKey", key); put("sourceBaseId", nullable(listing.baseId)); put("itemId", listing.itemId)
            put("priceLamports", listing.priceLamports); put("status", listing.status); put("reference", nullable(consent.reference))
        }, "Cancel item listing", quote = buildJsonObject { put("listingId", listing.id) })
    }
    override fun terminal(value: MarketCancellationReceipt): Boolean = value.state != "pending"
    override fun result(intent: PendingIntent, response: JsonObject): MarketCancellationReceipt {
        val listingId = requireNotNull(intent.quote).tradeText("listingId")
        val listing = OwnMarketListing(listingId, intent.body.tradeText("itemId"), intent.baseId, intent.body.tradeText("priceLamports"), intent.body.tradeText("status"))
        val reference = intent.body.tradeOptional("reference")
        val expected = this.intent(intent.wallet, intent.idempotencyKey, MarketCancelConsent(listing, reference))
        require(intent.path == expected.path && intent.body == expected.body && intent.quote == expected.quote)
        return MarketCancellationReceipt.from(response).also {
            require(it.key == intent.idempotencyKey && it.actor == intent.wallet && it.listingId == listingId && it.itemId == listing.itemId &&
                it.sourceBaseId == listing.baseId && it.priceLamports == listing.priceLamports && it.expectedStatus == listing.status && it.expectedReference == reference)
        }
    }
}
