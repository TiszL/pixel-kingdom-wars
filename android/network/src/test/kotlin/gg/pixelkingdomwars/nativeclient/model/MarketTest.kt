package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MarketTest {
    private val address = "DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"
    private val id = "11111111-1111-4111-8111-111111111111"
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun row(price: String = "9007199254740993", base: String = "null") = """{"id":"$id","seller":"$address","baseId":$base,"itemId":"wardens_helm","priceLamports":"$price","createdAt":"2026-09-12T12:00:00.000Z"}"""
    private fun book(rows: String = row(), summary: String = "") = json("""{"feeBps":250,"listings":[$rows],"summary":[$summary]}""")
    private fun links(tensor: String = "https://www.tensor.trade/item/$address") = json("""{"tensor":"$tensor","magicEden":"https://magiceden.io/item-details/$address"}""")

    @Test fun `large amounts and tiny prices remain exact instead of rounding an offer to free`() {
        val offer = MarketBook.from(book()).offers.single()
        assertEquals("9007199254740993", offer.priceLamports)
        assertEquals("9007199.254740993", marketSol(offer.priceLamports))
        assertEquals("0.000000001", marketSol("1"))
        assertEquals("2.5", marketPercent(250))
    }
    @Test fun `book summary covers other items and never derives volume from the visible offers`() {
        val summary = """{"itemId":"keg_of_haste","floorLamports":"200000","listed":103}"""
        val parsed = MarketBook.from(book(summary = summary))
        assertEquals("wardens_helm", parsed.offers.single().itemId)
        assertEquals("keg_of_haste", parsed.summary.single().itemId)
        assertEquals(103, parsed.summary.single().listed)
    }
    @Test fun `malformed or duplicate offers cannot appear as valid prices`() {
        listOf("0", "-1", "01", "1.5", "1e3", "9223372036854775808").forEach { price ->
            assertThrows(IllegalArgumentException::class.java) { MarketBook.from(book(row(price))) }
        }
        assertThrows(IllegalArgumentException::class.java) { MarketBook.from(book("${row()},${row()}")) }
        assertThrows(IllegalArgumentException::class.java) { MarketBook.from(book(row(base = "\"a-different-base\""))) }
        assertThrows(IllegalArgumentException::class.java) { MarketBook.from(book().let { JsonObject(it + ("feeBps" to JsonPrimitive(10001))) }) }
    }
    @Test fun `own list remains open rows across deed and wallet custody and rejects terminal history`() {
        fun own(status: String, base: String) = json("""{"listings":[{"id":"$id","itemId":"wardens_helm","baseId":$base,"priceLamports":"100000","status":"$status"}]}""")
        assertNull(OwnMarketListing.list(own("active", "null")).single().baseId)
        assertEquals(id, OwnMarketListing.list(own("reserved", "\"$id\"")).single().baseId)
        listOf("sold", "cancelled", "pending").forEach { assertThrows(IllegalArgumentException::class.java) { OwnMarketListing.list(own(it, "null")) } }
    }
    @Test fun `external market URLs reject non https tokens credentials redirects and custom ports`() {
        listOf("javascript:alert(1)", "https://name:secret@www.tensor.trade/item/$address", "https://www.tensor.trade:8443/item/$address",
            "https://www.tensor.trade/item/$address?token=secret", "https://www.tensor.trade/item/$address#target").forEach {
            assertThrows(IllegalArgumentException::class.java) { MarketLinks.from(links(it)) }
        }
        assertEquals("https://www.tensor.trade/item/$address", MarketLinks.from(links()).tensor)
    }
    @Test fun `unconfigured collection is distinct from enabled links and assets preserve frozen status`() {
        val empty = CoreMarketCollection.from(json("""{"collection":null,"feeBps":500,"tradingEnabled":false,"links":null}"""))
        assertNull(empty.collection); assertNull(empty.links); assertEquals(500, empty.royaltyBps)
        assertThrows(IllegalArgumentException::class.java) { CoreMarketCollection.from(json("""{"collection":"$address","feeBps":500,"tradingEnabled":false,"links":null}""")) }
        val asset = """{"id":"$address","name":"EARTH LAND DEED","image":null,"frozen":true,"kind":"deed","links":${links()}}"""
        val result = CoreMarketAssets.from(json("""{"assets":[$asset],"dasConfigured":false,"tradingEnabled":false}"""))
        assertTrue(result.assets.single().frozen); assertFalse(result.dasConfigured)
        assertThrows(IllegalArgumentException::class.java) { CoreMarketAssets.from(json("""{"assets":[$asset,$asset],"dasConfigured":true,"tradingEnabled":true}""")) }
    }
}
