package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LegacyMarketTest {
    private val id = "11111111-1111-4111-8111-111111111111"
    private val reference = "11111111111111111111111111111111"
    private fun raw(text: String) = Json.parseToJsonElement(text).jsonObject
    private val row get() = raw("""{"listingId":"$id","itemId":"marcher_greaves","reference":"$reference","priceLamports":"30000000000","buyerBaseId":null}""")
    @Test fun `legacy page retains exact terms without manufacturing a payable quote`() {
        val page = LegacyMarketPage.from(buildJsonObject { put("purchases", JsonArray(listOf(row))); put("next", id) })
        assertEquals("30000000000", page.purchases.single().priceLamports)
        assertEquals(reference, page.purchases.single().reference); assertNull(page.purchases.single().buyerBaseId)
    }
    @Test fun `malformed duplicate and mismatched cursor observations fail closed`() {
        fun page(rows: List<JsonObject>, next: JsonElement = JsonNull) = buildJsonObject { put("purchases", JsonArray(rows)); put("next", next) }
        assertTrue(runCatching { LegacyMarketPage.from(page(listOf(row, row))) }.isFailure)
        assertTrue(runCatching { LegacyMarketPage.from(page(listOf(row), JsonPrimitive("22222222-2222-4222-8222-222222222222"))) }.isFailure)
        for ((key, value) in listOf("reference" to JsonPrimitive("unsafe/route"), "priceLamports" to JsonPrimitive(30), "buyerBaseId" to JsonPrimitive("other"))) {
            assertTrue(runCatching { LegacyMarketPage.from(page(listOf(JsonObject(row + (key to value))))) }.isFailure)
        }
    }
    @Test fun `history validates private trade role exact price and transaction signature`() {
        val trade = JsonObject(row.filterKeys { it != "reference" } + mapOf("role" to JsonPrimitive("bought"), "txSignature" to JsonPrimitive("1".repeat(64)), "settledAt" to JsonNull))
        fun history(value: JsonObject) = buildJsonObject { put("trades", JsonArray(listOf(value))); put("hasMore", true) }
        assertEquals("bought", MarketTradeHistory.from(history(trade)).trades.single().role)
        assertTrue(runCatching { MarketTradeHistory.from(history(JsonObject(trade + ("role" to JsonPrimitive("owner"))))) }.isFailure)
        assertTrue(runCatching { MarketTradeHistory.from(history(JsonObject(trade + ("txSignature" to JsonPrimitive("invalid"))))) }.isFailure)
    }
}
