package gg.pixelkingdomwars.nativeclient.model

import java.math.BigInteger
import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.*

/** Curated shared/market.ts v1 receipts. These documents, never the book, prove an order. */
object MarketContract {
    fun text(raw: JsonObject, key: String): String = requireNotNull((raw[key] as? JsonPrimitive)?.takeIf { it.isString }?.content)
    fun optional(raw: JsonObject, key: String): String? { require(key in raw); return if (raw[key] == JsonNull) null else text(raw, key) }
    fun flag(raw: JsonObject, key: String): Boolean = requireNotNull((raw[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull)
    fun integer(raw: JsonObject, key: String): Int = requireNotNull((raw[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
    fun id(value: String) = value.also { require(UUID.fromString(it).toString() == it) }
    fun key(value: String) = value.also { require(it.length in 8..128) }
    fun address(value: String) = value.also { require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))) }
    fun signature(value: String) = value.also { require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{64,88}"))) }
    fun item(value: String) = value.also { require(it.isNotEmpty() && it.length <= 64) }
    fun date(value: String) = value.also { require(it.endsWith('Z')); Instant.parse(it) }
    fun amount(value: String, zero: Boolean = false) = value.also {
        require(it.length in 1..19 && it.matches(Regex(if (zero) "0|[1-9][0-9]*" else "[1-9][0-9]*")) && BigInteger(it).bitLength() <= 63)
    }
    fun supported(book: JsonObject): Boolean {
        val feature = (book["features"] as? JsonObject)?.get("itemMarket") as? JsonObject ?: return false
        return listOf("version", "listingReceipts", "reservationReceipts", "cancelReceipts").all { feature[it] == JsonPrimitive(1) }
    }
}

data class MarketListingReceipt(val raw: JsonObject, val key: String, val creator: String, val listingId: String,
    val itemId: String, val sourceBaseId: String?, val priceLamports: String, val createdAt: String) {
    companion object { fun from(raw: JsonObject): MarketListingReceipt = with(MarketContract) {
        require(integer(raw, "version") == 1)
        MarketListingReceipt(raw, key(text(raw, "idempotencyKey")), address(text(raw, "creator")), id(text(raw, "listingId")),
            item(text(raw, "itemId")), optional(raw, "sourceBaseId")?.let(::id), amount(text(raw, "priceLamports")), date(text(raw, "createdAt")))
    } }
}

/** Every public payment term is kept verbatim; equality excludes the changing receipt envelope. */
data class MarketQuote(val raw: JsonObject, val key: String?, val reservationId: String, val listingId: String,
    val itemId: String, val buyer: String, val seller: String, val sourceBaseId: String?, val buyerBaseId: String?,
    val cluster: String, val reference: String, val priceLamports: String, val feeBps: Int,
    val sellerLamports: String, val feeLamports: String, val feeTreasury: String, val createdAt: String, val payableUntil: String) {
    companion object { fun from(raw: JsonObject): MarketQuote = with(MarketContract) {
        require(integer(raw, "version") == 1)
        val q = MarketQuote(raw, optional(raw, "idempotencyKey")?.let(::key), id(text(raw, "reservationId")), id(text(raw, "listingId")),
            item(text(raw, "itemId")), address(text(raw, "buyer")), address(text(raw, "seller")), optional(raw, "sourceBaseId")?.let(::id),
            optional(raw, "buyerBaseId")?.let(::id), text(raw, "cluster"), address(text(raw, "reference")), amount(text(raw, "priceLamports")),
            integer(raw, "feeBps"), amount(text(raw, "sellerLamports")), amount(text(raw, "feeLamports"), zero = true),
            address(text(raw, "feeTreasury")), date(text(raw, "createdAt")), date(text(raw, "payableUntil")))
        require(q.cluster in setOf("devnet", "mainnet-beta") && q.feeBps in 0..10_000)
        require(q.priceLamports.toBigInteger() == q.sellerLamports.toBigInteger() + q.feeLamports.toBigInteger())
        require(q.feeLamports.toBigInteger() == q.priceLamports.toBigInteger() * q.feeBps.toBigInteger() / BigInteger.valueOf(10_000))
        require(setOf(q.buyer, q.seller, q.feeTreasury).size == 3 && (q.sourceBaseId == null) == (q.buyerBaseId == null))
        require(Instant.parse(q.payableUntil) > Instant.parse(q.createdAt)); q
    } }
}

data class MarketReservationReceipt(val raw: JsonObject, val quote: MarketQuote, val serverNow: String, val payable: Boolean,
    val state: String, val paymentSignature: String?, val txSignature: String?, val resolvedAt: String?) {
    val terminal: Boolean get() = state in setOf("settled", "superseded", "cancelled")
    companion object { fun from(raw: JsonObject): MarketReservationReceipt = with(MarketContract) {
        val r = MarketReservationReceipt(raw, MarketQuote.from(requireNotNull(raw["quote"] as? JsonObject)), date(text(raw, "serverNow")),
            flag(raw, "payable"), text(raw, "state"), optional(raw, "paymentSignature")?.let(::signature),
            optional(raw, "txSignature")?.let(::signature), optional(raw, "resolvedAt")?.let(::date))
        require(r.state in setOf("reserved", "committed", "settled", "superseded", "cancelled"))
        require(!r.payable || (r.state == "reserved" && Instant.parse(r.serverNow) < Instant.parse(r.quote.payableUntil)))
        when (r.state) {
            "reserved" -> require(r.paymentSignature == null && r.txSignature == null && r.resolvedAt == null)
            "committed" -> require(r.paymentSignature != null && r.txSignature == null && r.resolvedAt == null && !r.payable)
            "settled" -> require(r.txSignature != null && r.resolvedAt != null && !r.payable && (r.paymentSignature == null || r.paymentSignature == r.txSignature))
            else -> require(r.txSignature == null && r.resolvedAt != null && !r.payable)
        }; r
    } }
}

data class MarketCancellationSettlement(val reference: String, val txSignature: String, val buyer: String, val buyerBaseId: String?)
data class MarketCancellationReceipt(val raw: JsonObject, val key: String, val actor: String, val listingId: String, val itemId: String,
    val sourceBaseId: String?, val priceLamports: String, val expectedStatus: String, val expectedReference: String?, val state: String,
    val resolvedAt: String?, val refusalCode: String?, val settlement: MarketCancellationSettlement?) {
    companion object { fun from(raw: JsonObject): MarketCancellationReceipt = with(MarketContract) {
        require(integer(raw, "version") == 1); date(text(raw, "createdAt")); require("settlement" in raw)
        val settlement = if (raw["settlement"] == JsonNull) null else requireNotNull(raw["settlement"] as? JsonObject).let {
            MarketCancellationSettlement(address(text(it, "reference")), signature(text(it, "txSignature")), address(text(it, "buyer")), optional(it, "buyerBaseId")?.let(::id))
        }
        val r = MarketCancellationReceipt(raw, key(text(raw, "idempotencyKey")), address(text(raw, "actor")), id(text(raw, "listingId")),
            item(text(raw, "itemId")), optional(raw, "sourceBaseId")?.let(::id), amount(text(raw, "priceLamports")), text(raw, "expectedStatus"),
            optional(raw, "expectedReference")?.let(::address), text(raw, "state"), optional(raw, "resolvedAt")?.let(::date), optional(raw, "refusalCode"), settlement)
        require(r.expectedStatus in setOf("active", "reserved") && (r.expectedStatus == "active") == (r.expectedReference == null))
        require(r.state in setOf("pending", "cancelled", "settled", "refused"))
        if (r.state == "pending") require(r.resolvedAt == null && r.refusalCode == null && r.settlement == null)
        else {
            require(r.resolvedAt != null)
            when (r.state) {
                "settled" -> require(settlement != null && r.refusalCode == null && settlement.reference == r.expectedReference && (settlement.buyerBaseId == null) == (r.sourceBaseId == null))
                "refused" -> require(settlement == null && r.refusalCode != null && r.refusalCode.length in 1..64)
                else -> require(settlement == null && r.refusalCode == null)
            }
        }; r
    } }
}

/** V1 own-listing read supplies the exact generation the seller is choosing to cancel. */
data class MarketCancelConsent(val listing: OwnMarketListing, val reference: String?) {
    companion object { fun list(raw: JsonObject): List<MarketCancelConsent> {
        val listings = OwnMarketListing.list(raw)
        val rows = requireNotNull(raw["listings"] as? JsonArray)
        return listings.mapIndexed { index, listing ->
            val consent = requireNotNull(rows[index].jsonObject["cancelConsent"] as? JsonObject)
            require(MarketContract.integer(consent, "version") == 1 && MarketContract.text(consent, "status") == listing.status)
            val reference = MarketContract.optional(consent, "reference")?.let(MarketContract::address)
            require((listing.status == "active") == (reference == null)); MarketCancelConsent(listing, reference)
        }
    } }
}
