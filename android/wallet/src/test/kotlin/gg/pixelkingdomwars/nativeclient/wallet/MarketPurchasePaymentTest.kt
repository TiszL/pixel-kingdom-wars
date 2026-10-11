package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.model.MarketQuote
import java.math.BigInteger
import java.util.Base64
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MarketPurchasePaymentTest {
    private val fixture = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/market-purchase-wire.json")).readText()).jsonObject
    private val quote = MarketQuote.from(fixture["quote"]!!.jsonObject)
    private fun rpc(balance: Long = 205000, calls: MutableList<String> = mutableListOf()) = SolanaRpc { request ->
        val method = request["method"]!!.jsonPrimitive.content; calls += method
        val result = when (method) {
            "getLatestBlockhash" -> buildJsonObject { put("value", buildJsonObject { put("blockhash", fixture["blockhash"]!!); put("lastValidBlockHeight", 4242) }) }
            "getFeeForMessage" -> buildJsonObject { put("value", 5000) }
            "getBalance" -> buildJsonObject { put("value", balance) }
            else -> error("No payment or wallet action belongs in a preparation test")
        }
        buildJsonObject { put("result", result) }
    }
    @Test fun `complete unsigned transaction matches the actual canonical web builder`() = runBlocking {
        val calls = mutableListOf<String>()
        val prepared = MarketPurchasePayment.prepare(rpc(calls = calls), quote)
        assertArrayEquals(Base64.getDecoder().decode(fixture["unsigned"]!!.jsonPrimitive.content), prepared.transaction)
        assertEquals(BigInteger.valueOf(5000), prepared.feeLamports)
        assertEquals("Saved with the attempt: it is what later proves a null signature status final", 4242L, prepared.lastValidBlockHeight)
        assertEquals(listOf("getLatestBlockhash", "getFeeForMessage", "getBalance"), calls)
        val generated = JsonArray(MarketPurchasePayment.instructions(quote).map { ix -> buildJsonObject {
            put("program", base58(ix.programId)); put("data", ix.data.joinToString("") { "%02x".format(it.toInt() and 255) })
            put("keys", JsonArray(ix.keys.map { meta -> buildJsonObject {
                put("address", base58(meta.key)); put("signer", meta.signer); put("writable", meta.writable)
            } }))
        } })
        assertEquals(fixture["instructions"], generated)
        assertEquals(3, generated[0].jsonObject["keys"]!!.jsonArray.size)
        assertEquals(2, generated[1].jsonObject["keys"]!!.jsonArray.size)
    }
    @Test fun `balance must cover the full frozen price and network fee`() = runBlocking {
        assertThrows(IllegalStateException::class.java) { runBlocking { MarketPurchasePayment.prepare(rpc(balance = 204999), quote) } }
        Unit
    }
    @Test fun `a zero fee still preserves the two canonical atomic transfer instructions`() {
        val raw = JsonObject(quote.raw + mapOf("feeBps" to JsonPrimitive(0), "feeLamports" to JsonPrimitive("0"), "sellerLamports" to JsonPrimitive("200000")))
        val legs = MarketPurchasePayment.instructions(MarketQuote.from(raw))
        assertEquals(2, legs.size); assertArrayEquals(byteArrayOf(2,0,0,0,0,0,0,0,0,0,0,0), legs[1].data)
    }
    @Test fun `a copied quote cannot substitute a recipient without changing its frozen document`() {
        assertThrows(IllegalArgumentException::class.java) { MarketPurchasePayment.instructions(quote.copy(seller = quote.reference)) }
        assertThrows(IllegalArgumentException::class.java) { MarketPurchasePayment.instructions(MarketQuote.from(JsonObject(quote.raw + ("reference" to JsonPrimitive(quote.buyer))))) }
    }
}
