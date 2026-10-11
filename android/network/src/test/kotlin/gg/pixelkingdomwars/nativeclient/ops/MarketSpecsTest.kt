package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MarketSpecsTest {
    private val buyer = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val seller = "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"
    private val treasury = "D37fYaEdaF9BcUJ65gojUC4ChS9r9k9fVRHK2fdxvbk8"
    private val reference = "6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKPD"
    private val key = "00000000-0000-4000-8000-000000000001"
    private val listing = "00000000-0000-4000-8000-000000000002"
    private val reservation = "00000000-0000-4000-8000-000000000003"
    private val source = "00000000-0000-4000-8000-000000000004"
    private val destination = "00000000-0000-4000-8000-000000000005"
    private val signature = "2".repeat(64)
    private val created = "2026-09-13T00:00:00Z"
    private fun JsonObject.changed(key: String, value: JsonElement) = JsonObject(this + (key to value))
    private fun quote() = buildJsonObject {
        put("version", 1); put("idempotencyKey", key); put("reservationId", reservation); put("listingId", listing)
        put("itemId", "sword"); put("buyer", buyer); put("seller", seller); put("sourceBaseId", source); put("buyerBaseId", destination)
        put("cluster", "devnet"); put("reference", reference); put("priceLamports", "200000"); put("feeBps", 500)
        put("sellerLamports", "190000"); put("feeLamports", "10000"); put("feeTreasury", treasury)
        put("createdAt", created); put("payableUntil", "2026-09-13T00:02:00Z")
    }
    private fun receipt(state: String = "reserved") = buildJsonObject {
        put("quote", quote()); put("serverNow", "2026-09-13T00:00:10Z"); put("payable", state == "reserved"); put("state", state)
        put("paymentSignature", if (state == "committed") JsonPrimitive(signature) else JsonNull)
        put("txSignature", if (state == "settled") JsonPrimitive(signature) else JsonNull)
        put("resolvedAt", if (state in setOf("settled", "superseded", "cancelled")) JsonPrimitive(created) else JsonNull)
    }
    private fun offer() = MarketOffer(listing, seller, source, "sword", "200000", created)
    private fun listingReceipt() = buildJsonObject {
        put("version", 1); put("idempotencyKey", key); put("creator", seller); put("listingId", listing)
        put("itemId", "sword"); put("sourceBaseId", source); put("priceLamports", "200000"); put("createdAt", created)
    }
    private fun cancelReceipt(state: String = "cancelled") = buildJsonObject {
        put("version", 1); put("idempotencyKey", key); put("actor", seller); put("listingId", listing); put("itemId", "sword")
        put("sourceBaseId", source); put("priceLamports", "200000"); put("expectedStatus", "reserved"); put("expectedReference", reference)
        put("createdAt", created); put("state", state); put("resolvedAt", if (state == "pending") JsonNull else JsonPrimitive(created))
        put("refusalCode", if (state == "refused") JsonPrimitive("MARKET_CANCEL_REFUSED") else JsonNull)
        put("settlement", if (state != "settled") JsonNull else buildJsonObject {
            put("reference", reference); put("txSignature", signature); put("buyer", buyer); put("buyerBaseId", destination)
        })
    }
    @Test fun `production without every v1 receipt family stays read only`() {
        assertFalse(MarketContract.supported(buildJsonObject {}))
        val fields = buildJsonObject { listOf("version", "listingReceipts", "reservationReceipts", "cancelReceipts").forEach { put(it, 1) } }
        fun book(feature: JsonObject) = buildJsonObject { put("features", buildJsonObject { put("itemMarket", feature) }) }
        assertTrue(MarketContract.supported(book(fields)))
        for (name in fields.keys) {
            assertFalse(MarketContract.supported(book(JsonObject(fields - name))))
            assertFalse(MarketContract.supported(book(fields.changed(name, JsonPrimitive(2)))))
            assertFalse(MarketContract.supported(book(fields.changed(name, JsonPrimitive("1")))))
        }
    }
    @Test fun `frozen quote enforces exact integers custody split recipients and window`() {
        val good = quote(); assertEquals("190000", MarketQuote.from(good).sellerLamports)
        val invalid = listOf("priceLamports" to JsonPrimitive(200000), "feeBps" to JsonPrimitive("500"),
            "sellerLamports" to JsonPrimitive("190001"), "feeLamports" to JsonPrimitive("9999"), "feeTreasury" to JsonPrimitive(buyer),
            "buyerBaseId" to JsonNull, "payableUntil" to JsonPrimitive(created), "priceLamports" to JsonPrimitive("9223372036854775808"))
        for ((name, value) in invalid) assertThrows(IllegalArgumentException::class.java) { MarketQuote.from(good.changed(name, value)) }
    }
    @Test fun `a paid or expired receipt never invites another payment`() {
        for (state in listOf("committed", "settled", "superseded", "cancelled")) {
            assertFalse(MarketReservationReceipt.from(receipt(state)).payable)
            assertThrows(IllegalArgumentException::class.java) { MarketReservationReceipt.from(receipt(state).changed("payable", JsonPrimitive(true))) }
        }
        assertThrows(IllegalArgumentException::class.java) { MarketReservationReceipt.from(receipt().changed("serverNow", JsonPrimitive("2026-09-13T00:02:00Z"))) }
        assertThrows(IllegalArgumentException::class.java) { MarketReservationReceipt.from(receipt("settled").changed("txSignature", JsonNull)) }
    }
    @Test fun `listing proof names original creator source item price and exact command key`() {
        val intent = MarketListSpec.intent(seller, source, key, "sword", "200000")
        assertEquals("/market/v1/list/by-key/" + key, MarketListSpec.receiptRequest(intent).path)
        assertEquals(listing, MarketListSpec.acknowledge(intent, listingReceipt()).listingId)
        for ((name, value) in listOf("creator" to buyer, "sourceBaseId" to destination, "itemId" to "axe", "priceLamports" to "200001", "idempotencyKey" to reservation)) {
            assertThrows(ApiCompatibilityException::class.java) { MarketListSpec.acknowledge(intent, listingReceipt().changed(name, JsonPrimitive(value))) }
        }
    }
    @Test fun `reservation receipt must match original listing seller buyer both deeds item price and key`() {
        val intent = MarketReserveSpec.intent(buyer, destination, key, offer())
        val accepted = MarketReserveSpec.acknowledge(intent, receipt())
        assertEquals(quote(), accepted.quote.raw)
        assertEquals("/market/v1/reservations/by-key/" + key, MarketReserveSpec.receiptRequest(intent).path)
        for ((name, value) in listOf("listingId" to reservation, "seller" to reference, "buyer" to reference, "sourceBaseId" to destination,
            "buyerBaseId" to source, "itemId" to "axe", "idempotencyKey" to reservation)) {
            assertThrows(ApiCompatibilityException::class.java) { MarketReserveSpec.acknowledge(intent, receipt().changed("quote", quote().changed(name, JsonPrimitive(value)))) }
        }
        assertThrows(ApiCompatibilityException::class.java) { MarketReserveSpec.acknowledge(intent.copy(body = intent.body.changed("priceLamports", JsonPrimitive("200001"))), receipt()) }
    }
    @Test fun `a pending cancellation is not proof of delisting or a retired request`() {
        val intent = MarketCancelSpec.intent(seller, key, MarketCancelConsent(OwnMarketListing(listing, "sword", source, "200000", "reserved"), reference))
        assertEquals(Receipt.Unknown, MarketCancelSpec.decodeReceipt(intent, cancelReceipt("pending")))
        assertThrows(ApiCompatibilityException::class.java) { MarketCancelSpec.acknowledge(intent, cancelReceipt("pending")) }
        for (state in listOf("cancelled", "settled", "refused")) assertEquals(state, MarketCancelSpec.acknowledge(intent, cancelReceipt(state)).state)
        assertThrows(ApiCompatibilityException::class.java) { MarketCancelSpec.acknowledge(intent, cancelReceipt().changed("actor", JsonPrimitive(buyer))) }
        assertThrows(ApiCompatibilityException::class.java) { MarketCancelSpec.acknowledge(intent, cancelReceipt().changed("expectedReference", JsonPrimitive(treasury))) }
    }
    @Test fun `cancellation paid rescue preserves the exact reference and destination custody`() {
        val raw = cancelReceipt("settled"); val settlement = raw["settlement"]!!.jsonObject
        assertEquals(destination, MarketCancellationReceipt.from(raw).settlement!!.buyerBaseId)
        assertThrows(IllegalArgumentException::class.java) { MarketCancellationReceipt.from(raw.changed("settlement", settlement.changed("reference", JsonPrimitive(treasury)))) }
        assertThrows(IllegalArgumentException::class.java) { MarketCancellationReceipt.from(raw.changed("settlement", settlement.changed("buyerBaseId", JsonNull))) }
    }
    @Test fun `saved terminal proof restores without consulting the mutable order book`() {
        val intent = MarketReserveSpec.intent(buyer, destination, key, offer())
        val document = ReceiptDocument.fromReceiptRoute(receipt("settled"))
        assertEquals("settled", MarketReserveSpec.restore(intent, document).state)
        assertThrows(IllegalArgumentException::class.java) { MarketReserveSpec.restore(intent, document.changed("source", JsonPrimitive("book"))) }
    }
}
