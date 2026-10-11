package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.wallet.SignatureLanding
import gg.pixelkingdomwars.nativeclient.wallet.base58
import java.math.BigInteger
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MarketPurchaseStoreTest {
    private val q = marketQuote()
    private fun store(memory: MemoryStore, wallet: String = WALLET, origin: String = "https://localhost:18443", cluster: String = "devnet") = MarketPurchaseStore(memory, wallet, origin, cluster)
    @Test fun `origin wallet and network namespaces cannot import another payment`() {
        val memory = MemoryStore(); store(memory).adopt(marketReceipt(q))
        for (different in listOf(store(memory, wallet = q.seller), store(memory, origin = "https://play.pixelkingdomwars.com"), store(memory, cluster = "mainnet-beta"))) {
            assertThrows(IllegalArgumentException::class.java) { different.read() }
        }
        assertEquals(q, store(memory).read()!!.quote)
    }
    @Test fun `complete frozen quote round trips while another reservation cannot overwrite it`() {
        val memory = MemoryStore(); val s = store(memory); val saved = s.adopt(marketReceipt(q))
        assertEquals(saved, store(memory).read())
        val other = MarketQuote.from(JsonObject(q.raw + ("reservationId" to JsonPrimitive(BASE_ID))))
        assertThrows(IllegalArgumentException::class.java) { s.adopt(marketReceipt(other)) }
        assertEquals(saved, s.read())
    }
    @Test fun `attempt and matching signature precede broadcast and cannot be erased by a reserved observation`() {
        val s = store(MemoryStore()); s.adopt(marketReceipt(q)); s.attempted(q, 0L); s.recordSignature(q, MARKET_SIGNATURE, 0L)
        s.adopt(marketReceipt(q)); assertTrue(s.read()!!.attempted); assertEquals(MARKET_SIGNATURE, s.read()!!.signature)
        assertThrows(IllegalArgumentException::class.java) { s.refusedBeforeSignature(q) }
        assertThrows(IllegalArgumentException::class.java) { s.recordSignature(q, base58(ByteArray(64) { 24 }), 0L) }
        assertThrows(IllegalArgumentException::class.java) { s.close(q, true) }
    }
    @Test fun `observed committed proof becomes attempted and terminal state cannot regress`() {
        val s = store(MemoryStore()); s.adopt(marketReceipt(q, "committed", false, MARKET_SIGNATURE))
        assertTrue(s.read()!!.attempted)
        assertThrows(IllegalArgumentException::class.java) { s.adopt(marketReceipt(q)) }
        s.adopt(marketReceipt(q, "settled", false, MARKET_SIGNATURE))
        assertThrows(IllegalArgumentException::class.java) { s.adopt(marketReceipt(q, "committed", false, MARKET_SIGNATURE)) }
        assertThrows(IllegalArgumentException::class.java) { s.close(q, false) }
        s.close(q, true); assertNull(s.read())
    }
    @Test fun `corruption missing signature and forged raw data do not become an empty journal`() {
        val memory = MemoryStore(); val s = store(memory); s.adopt(marketReceipt(q)); s.attempted(q, 0L); s.recordSignature(q, MARKET_SIGNATURE, 0L)
        val raw = Json.parseToJsonElement(memory.value!!).jsonObject
        for (bad in listOf("broken", JsonObject(raw + ("attempted" to JsonPrimitive(false))).toString(), JsonObject(raw + ("quote" to JsonNull)).toString())) {
            memory.value = bad; assertThrows(Exception::class.java) { s.read() }; assertEquals(bad, memory.value)
        }
    }
    /** "4b": an attempted reservation the server ended unpaid used to stay saved forever and block every later
     * market purchase. It now leaves through one transition, and only with every proof of [UnpaidAttempt]. */
    @Test fun `an attempted reservation retires only when the server ended it unpaid, the margin passed and no signature stands`() {
        val margin = UnpaidAttempt.MARGIN_MS
        for (state in listOf("superseded", "cancelled")) {
            val s = store(MemoryStore()); s.adopt(marketReceipt(q)); s.attempted(q, 1_000L)
            // Still reserved: however old, the payment may yet settle.
            assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(s.read()!!.receipt, Long.MAX_VALUE / 2, null) }
            val latest = s.adopt(marketReceipt(q, state, false)).receipt
            assertThrows(IllegalArgumentException::class.java) { s.close(q, true) }
            assertThrows("Before the margin", IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, 1_000L + margin - 1, null) }
            assertThrows("A receipt other than the saved one", IllegalArgumentException::class.java) { s.retireUnpaidAttempt(marketReceipt(q), 1_000L + margin, null) }
            assertThrows("A verdict for a signature that was never recorded", IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, 1_000L + margin, SignatureLanding.NOT_FOUND) }
            assertNotNull(s.read())
            s.retireUnpaidAttempt(latest, 1_000L + margin, null); assertNull(s.read())
            // The rail accepts a new reservation immediately.
            val next = MarketQuote.from(JsonObject(q.raw + ("reservationId" to JsonPrimitive(BASE_ID))))
            assertEquals(next, s.adopt(marketReceipt(next)).quote)
        }
    }
    @Test fun `committed and settled receipts never retire and are adopted as before`() {
        val s = store(MemoryStore()); s.adopt(marketReceipt(q)); s.attempted(q, 0L)
        val committed = s.adopt(marketReceipt(q, "committed", false, MARKET_SIGNATURE)).receipt
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(committed, Long.MAX_VALUE / 2, SignatureLanding.NOT_FOUND) }
        val settled = s.adopt(marketReceipt(q, "settled", false, MARKET_SIGNATURE)).receipt
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(settled, Long.MAX_VALUE / 2, SignatureLanding.NOT_FOUND) }
        assertEquals("settled", s.read()!!.receipt.state); s.close(q, true); assertNull(s.read())
    }
    /** Rewritten with the rule it now pins: NOT_FOUND used to mean "the status is null". A lagging or pruned node
     * says null for a payment that landed, so NOT_FOUND now means "null AND the node finalized past the saved last-valid
     * block height"; a null that is not proven ([SignatureLanding.UNPROVEN]) never retires, and neither does a
     * NOT_FOUND for a purchase that saved no height to prove it against (a journal of the previous version). */
    @Test fun `a recorded signature retires only on a null status proven final or a finalized error`() {
        for ((landing, retires) in listOf(null to false, SignatureLanding.PRESENT to false, SignatureLanding.UNPROVEN to false,
            SignatureLanding.NOT_FOUND to true, SignatureLanding.FAILED_FINALIZED to true)) {
            val s = store(MemoryStore()); s.adopt(marketReceipt(q)); s.attempted(q, 0L, 500L); s.recordSignature(q, MARKET_SIGNATURE, 0L)
            val latest = s.adopt(marketReceipt(q, "superseded", false)).receipt
            if (retires) { s.retireUnpaidAttempt(latest, UnpaidAttempt.MARGIN_MS, landing); assertNull(s.read()) }
            else { assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, UnpaidAttempt.MARGIN_MS, landing) }; assertEquals(MARKET_SIGNATURE, s.read()!!.signature) }
        }
        // No saved height (a journal of the previous version, or a node that reported none): a null status can never be
        // proven final, so only the finalized error still retires.
        for ((landing, retires) in listOf(SignatureLanding.NOT_FOUND to false, SignatureLanding.UNPROVEN to false, SignatureLanding.FAILED_FINALIZED to true)) {
            val s = store(MemoryStore()); s.adopt(marketReceipt(q)); s.attempted(q, 0L); s.recordSignature(q, MARKET_SIGNATURE, 0L)
            val latest = s.adopt(marketReceipt(q, "superseded", false)).receipt; assertNull(s.read()!!.lastValidBlockHeight)
            if (retires) { s.retireUnpaidAttempt(latest, UnpaidAttempt.MARGIN_MS, landing); assertNull(s.read()) }
            else { assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, UnpaidAttempt.MARGIN_MS, landing) }; assertNotNull(s.read()) }
        }
    }
    /** The margin runs from the END of the wallet step: a wallet may broadcast with a fresh blockhash at any moment
     * until it answers, so an attempt whose wallet step ended late is young however long ago it began. */
    @Test fun `the margin is counted from the latest of the attempt start and the end of its wallet step`() {
        val margin = UnpaidAttempt.MARGIN_MS
        val s = store(MemoryStore()); s.adopt(marketReceipt(q)); s.attempted(q, 1_000L); assertNull(s.read()!!.walletEndedAtMs)
        assertEquals(211_000L, s.walletEnded(q, 211_000L).walletEndedAtMs)
        assertEquals("The stamp never moves back", 211_000L, s.walletEnded(q, 5_000L).walletEndedAtMs)
        val latest = s.adopt(marketReceipt(q, "superseded", false)).receipt; assertEquals(211_000L, s.read()!!.walletEndedAtMs)
        assertThrows("Past the margin from the START only", IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, 1_000L + margin, null) }
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, 211_000L + margin - 1, null) }
        s.retireUnpaidAttempt(latest, 211_000L + margin, null); assertNull(s.read())
        // The first recorded signature is such an end too, and a device clock set back cannot put the end before the start.
        val t = store(MemoryStore()); t.adopt(marketReceipt(q)); t.attempted(q, 300_000L, 500L)
        assertEquals(100_000L, t.recordSignature(q, MARKET_SIGNATURE, 100_000L).walletEndedAtMs)
        val ended = t.adopt(marketReceipt(q, "superseded", false)).receipt
        assertThrows(IllegalArgumentException::class.java) { t.retireUnpaidAttempt(ended, 300_000L + margin - 1, SignatureLanding.NOT_FOUND) }
        t.retireUnpaidAttempt(ended, 300_000L + margin, SignatureLanding.NOT_FOUND); assertNull(t.read())
    }
    /** A device clock that jumped forward makes every attempt look old. No attempt can start after `payableUntil`, so
     * the SERVER's own clock on the receipt must also be the margin past it. */
    @Test fun `a device clock far in the future retires nothing until the server clock is the margin past the payment deadline`() {
        val margin = UnpaidAttempt.MARGIN_MS
        val s = store(MemoryStore()); s.adopt(marketReceipt(q)); s.attempted(q, 1_000L)
        val early = s.adopt(marketReceipt(q, "superseded", false, serverNow = marketServerNow(q, margin - 1))).receipt
        assertTrue(s.read()!!.unpaidAttemptDue(Long.MAX_VALUE / 2)); assertFalse(s.read()!!.serverPastMargin)
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(early, Long.MAX_VALUE / 2, null) }
        assertNotNull(s.read())
        val late = s.adopt(marketReceipt(q, "superseded", false, serverNow = marketServerNow(q, margin))).receipt
        assertThrows("The server clock alone is not enough either", IllegalArgumentException::class.java) { s.retireUnpaidAttempt(late, 1_000L + margin - 1, null) }
        s.retireUnpaidAttempt(late, 1_000L + margin, null); assertNull(s.read())
    }
    @Test fun `a journal of the previous version has neither new stamp, and both survive reconstruction or fail closed`() {
        val memory = MemoryStore(); val s = store(memory); s.adopt(marketReceipt(q)); s.attempted(q, 42L)
        assertFalse(memory.value!!.contains("walletEndedAtMs")); assertFalse(memory.value!!.contains("lastValidBlockHeight"))
        val legacy = store(memory).read()!!; assertEquals(42L, legacy.attemptedAtMs); assertNull(legacy.walletEndedAtMs); assertNull(legacy.lastValidBlockHeight)
        s.refusedBeforeSignature(q); s.attempted(q, 50L, 900L); s.recordSignature(q, MARKET_SIGNATURE, 60L)
        val rebuilt = store(memory).read()!!; assertEquals(60L, rebuilt.walletEndedAtMs); assertEquals(900L, rebuilt.lastValidBlockHeight)
        s.adopt(marketReceipt(q)); assertEquals(rebuilt.copy(), s.read())
        val raw = Json.parseToJsonElement(memory.value!!).jsonObject
        for (key in listOf("walletEndedAtMs", "lastValidBlockHeight")) for (bad in listOf(JsonPrimitive("77"), JsonNull, JsonPrimitive(-1))) {
            memory.value = JsonObject(raw + (key to bad)).toString(); assertThrows("$key=$bad", Exception::class.java) { s.read() }
        }
    }
    @Test fun `a purchase saved before the attempt time existed is old only by its own payable-until deadline`() {
        val memory = MemoryStore(); val s = store(memory); s.adopt(marketReceipt(q)); s.attempted(q, 5L)
        val latest = s.adopt(marketReceipt(q, "superseded", false)).receipt
        // The journal as the previous app version wrote it: no attemptedAtMs key at all.
        memory.value = JsonObject(Json.parseToJsonElement(memory.value!!).jsonObject - "attemptedAtMs").toString()
        val legacy = s.read()!!; assertTrue(legacy.attempted); assertNull(legacy.attemptedAtMs)
        val deadline = java.time.Instant.parse(q.payableUntil).toEpochMilli()
        assertThrows(IllegalArgumentException::class.java) { s.retireUnpaidAttempt(latest, deadline + UnpaidAttempt.MARGIN_MS, null) }
        s.retireUnpaidAttempt(latest, deadline + UnpaidAttempt.MARGIN_MS + 1, null); assertNull(s.read())
    }
    @Test fun `the attempt time survives storage reconstruction, is dropped by a refusal and a malformed one fails closed`() {
        val memory = MemoryStore(); val s = store(memory); s.adopt(marketReceipt(q)); s.attempted(q, 42L)
        assertEquals(42L, store(memory).read()!!.attemptedAtMs); s.adopt(marketReceipt(q)); assertEquals(42L, s.read()!!.attemptedAtMs)
        assertNull(s.refusedBeforeSignature(q).attemptedAtMs); s.attempted(q, 77L); assertEquals(77L, s.read()!!.attemptedAtMs)
        val raw = Json.parseToJsonElement(memory.value!!).jsonObject
        for (bad in listOf(JsonPrimitive("77"), JsonNull, JsonPrimitive(-1))) {
            memory.value = JsonObject(raw + ("attemptedAtMs" to bad)).toString(); assertThrows(Exception::class.java) { s.read() }
        }
    }
    @Test fun `SOL price input is exact to nine decimals and respects canonical catalogue bounds`() {
        val bounds = MarketTradeBounds(BigInteger("1"), BigInteger("1000000000000"), 2500, 15000)
        assertEquals("1", bounds.price("0.000000001")); assertEquals("1234567891", bounds.price("1.234567891"))
        for (bad in listOf("0", "-1", "1e2", "1.0000000001", "1000.000000001", "NaN")) assertThrows(IllegalArgumentException::class.java) { bounds.price(bad) }
        assertNull(MarketTradeBounds.from(json("{}")))
        val parsed = MarketTradeBounds.from(json("""{"constants":{"MARKETPLACE":{"itemMarket":{"minPriceLamports":2,"maxPriceLamports":900}},"LAND_CHECKOUT_RECOVERY":{"pollMs":3000,"requestTimeoutMs":9000}}}"""))!!
        assertEquals(BigInteger("2"), parsed.minPrice); assertEquals(BigInteger("900"), parsed.maxPrice); assertEquals(3000L, parsed.pollMs)
    }
}
