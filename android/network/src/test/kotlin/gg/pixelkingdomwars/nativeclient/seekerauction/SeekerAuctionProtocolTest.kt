package gg.pixelkingdomwars.nativeclient.seekerauction

import java.util.Base64
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic policy deliberately differs from production; numbers must be injected, never copied into the port. */
internal object AuctionFixtures {
    val policy = SeekerAuctionProtocolPolicy(totalSpots = 3, kingSpots = 1, realmCount = 3, regularRealmCount = 2, refundPageSize = 2)
    const val wallet = "11111111111111111111111111111112"
    const val other = "11111111111111111111111111111113"
    val signature = "2".repeat(88)
    val otherSignature = "3".repeat(88)
    // Independent base58 vector for signature = "2" repeated 88 times; never use the production decoder here.
    val signatureBytes = Base64.getDecoder().decode("MuT9RPNV7cWxPNesIcEkUz/eIFkbgztwdtN3ub6c/hg2QEBgMxaZPSta3OngkGuK0hofycUR9wR9wR9wR9wR9w==")
    val signedWire = Base64.getEncoder().encodeToString(byteArrayOf(1) + signatureBytes + byteArrayOf(1))
    fun round(): JsonObject = Json.parseToJsonElement("""{
      "version":1,"source":"chain","chainUnixTime":"1090","walletSkrRaw":"9007199254740993",
      "wallet":"$wallet","observedSlot":"9","round":"1","biddingRound":"1","admissionPaused":false,
      "config":{"programId":"$other","address":"$other","mint":"$other","prizeOwner":"$other","prizeAta":"$other",
        "decimals":3,"openingBidRaw":"7","firstOperatingStart":"1000","termSec":"100","auctionSec":"20","graceSec":"5"},
      "auctionStart":"1080","auctionEnd":"1100","operatingStart":"1100","operatingEnd":"1200",
      "openedCount":3,"completedCount":0,"winnerCount":0,"completedAt":null,
      "spots":[
        {"spot":0,"class":"king","realmMask":7,"opened":true,"highBidRaw":"0","highBidder":null,"settled":false,"yourBidRaw":"0","refundable":false},
        {"spot":1,"class":"regular","realmMask":3,"opened":true,"highBidRaw":"0","highBidder":null,"settled":false,"yourBidRaw":"0","refundable":false},
        {"spot":2,"class":"regular","realmMask":6,"opened":true,"highBidRaw":"0","highBidder":null,"settled":false,"yourBidRaw":"0","refundable":false}]
    }""").jsonObject
    fun prepared(): JsonObject = buildJsonObject {
        put("messageBase64", "AQ=="); put("blockhash", other); put("lastValidBlockHeight", "11")
        put("incrementRaw", "9007199254740993"); put("networkFeeLamports", "13"); put("newAccountRentLamports", "17")
    }
    fun status(found: Boolean? = null, height: String? = null): JsonObject = buildJsonObject {
        put("signature", signature); put("status", "pending"); put("slot", JsonNull); put("error", JsonNull)
        if (found != null) put("found", found)
        if (height != null) put("finalizedBlockHeight", height)
    }
    fun refunds(): JsonObject = buildJsonObject {
        put("version", 1); put("source", "chain"); put("wallet", wallet); put("observedSlot", "7"); put("chainUnixTime", "1090")
        put("programId", other); put("config", other); put("mint", other); put("decimals", 3)
        putJsonArray("entries") {
            add(buildJsonObject { put("bid", wallet); put("auction", wallet); put("round", "10"); put("spot", 0); put("amountRaw", "9007199254740993") })
            add(buildJsonObject { put("bid", other); put("auction", other); put("round", "11"); put("spot", 1); put("amountRaw", "9") })
        }
        put("nextCursor", buildJsonObject { put("round", "11"); put("spot", 1) })
    }
    fun change(raw: JsonObject, key: String, value: JsonElement) = JsonObject(raw + (key to value))
}

class SeekerAuctionProtocolTest {
    private val p = SeekerAuctionProtocol(AuctionFixtures.policy)
    private fun rejected(block: () -> Unit) { assertThrows(Exception::class.java, block) }
    @Test fun `sourced amounts beyond JS safe integer stay exact strings`() {
        val view = p.round(AuctionFixtures.round()); assertEquals("9007199254740993", view.walletSkrRaw)
        assertEquals("9007199254740993", p.prepared(AuctionFixtures.prepared()).incrementRaw)
    }
    @Test fun `round requires provenance clock and nullable ATA balance fields`() {
        listOf("source", "chainUnixTime", "walletSkrRaw").forEach { key -> rejected { p.round(JsonObject(AuctionFixtures.round() - key)) } }
    }
    @Test fun `fixture never establishes bid readiness`() {
        val view = p.round(AuctionFixtures.change(AuctionFixtures.round(), "source", JsonPrimitive("fixture")))
        assertFalse(view.bidWindowOpen(0))
    }
    @Test fun `window comes from chain time and complete open vector`() {
        assertTrue(p.round(AuctionFixtures.round()).bidWindowOpen(0))
        for (time in listOf("1079", "1100")) assertFalse(p.round(AuctionFixtures.change(AuctionFixtures.round(), "chainUnixTime", JsonPrimitive(time))).bidWindowOpen(0))
        assertFalse(p.round(AuctionFixtures.change(AuctionFixtures.round(), "admissionPaused", JsonPrimitive(true))).bidWindowOpen(0))
        assertFalse(p.round(AuctionFixtures.change(AuctionFixtures.round(), "biddingRound", JsonPrimitive("2"))).bidWindowOpen(0))
    }
    @Test fun `canonical u64 rejects coercion whitespace sign leading zero decimal and overflow`() {
        listOf("-1", "+1", "01", " 1", "1e2", "1.0", "18446744073709551616").forEach { value ->
            rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "observedSlot", JsonPrimitive(value))) }
        }
        rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "observedSlot", JsonPrimitive(1))) }
    }
    @Test fun `u64 max is retained without narrowing to signed long`() {
        assertEquals("18446744073709551615", p.round(AuctionFixtures.change(AuctionFixtures.round(), "walletSkrRaw", JsonPrimitive("18446744073709551615"))).walletSkrRaw)
    }
    @Test fun `canonical i64 rejects negative zero and out of range`() {
        listOf("-0", "01", "9223372036854775808", "-9223372036854775809").forEach { value ->
            rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "chainUnixTime", JsonPrimitive(value))) }
        }
        assertEquals("-9223372036854775808", p.round(AuctionFixtures.change(AuctionFixtures.round(), "chainUnixTime", JsonPrimitive("-9223372036854775808"))).chainUnixTime)
    }
    @Test fun `extra fields rejected at root and inside config`() {
        rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "walletQuote", JsonPrimitive("0"))) }
        val config = AuctionFixtures.round().getValue("config").jsonObject
        rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "config", AuctionFixtures.change(config, "fee", JsonPrimitive("0")))) }
    }
    @Test fun `injected layout checks length order class and realm mask`() {
        val raw = AuctionFixtures.round(); val spots = raw.getValue("spots").jsonArray
        rejected { SeekerAuctionProtocol(AuctionFixtures.policy.copy(totalSpots = 4)).round(raw) }
        for ((key, value) in listOf("spot" to JsonPrimitive(0), "class" to JsonPrimitive("king"), "realmMask" to JsonPrimitive(7))) {
            val rows = spots.toMutableList(); rows[1] = AuctionFixtures.change(rows[1].jsonObject, key, value)
            rejected { p.round(AuctionFixtures.change(raw, "spots", JsonArray(rows))) }
        }
    }
    @Test fun `calendar arithmetic cannot wrap or accept mismatched schedule`() {
        rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "operatingEnd", JsonPrimitive("1199"))) }
        rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "round", JsonPrimitive("18446744073709551615"))) }
    }
    @Test fun `progress and completion agree with spot vector`() {
        rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "openedCount", JsonPrimitive(2))) }
        rejected { p.round(AuctionFixtures.change(AuctionFixtures.round(), "completedAt", JsonPrimitive("1100"))) }
    }
    @Test fun `high bidder and refund coherence are strict`() {
        val raw = AuctionFixtures.round(); val rows = raw.getValue("spots").jsonArray.toMutableList()
        rows[0] = AuctionFixtures.change(rows[0].jsonObject, "highBidRaw", JsonPrimitive("7"))
        rejected { p.round(AuctionFixtures.change(raw, "spots", JsonArray(rows))) }
    }
    @Test fun `prepared requires canonical base64 and canonical address bytes`() {
        listOf("AR==", "", "AQ=", "AQ==\n").forEach { value -> rejected { p.prepared(AuctionFixtures.change(AuctionFixtures.prepared(), "messageBase64", JsonPrimitive(value))) } }
        rejected { p.prepared(AuctionFixtures.change(AuctionFixtures.prepared(), "blockhash", JsonPrimitive("2".repeat(32)))) }
    }
    @Test fun `pending without observation pair is valid and not expired`() {
        val status = p.status(AuctionFixtures.status()); assertEquals("pending", status.status)
        assertNull(status.found); assertNull(status.finalizedBlockHeight)
    }
    @Test fun `found height fields are both present or both absent never explicit null`() {
        rejected { p.status(AuctionFixtures.status(found = false)) }
        rejected { p.status(AuctionFixtures.status(height = "12")) }
        rejected { p.status(AuctionFixtures.change(AuctionFixtures.status(), "found", JsonNull)) }
    }
    @Test fun `transaction terminal shapes cannot be fabricated`() {
        rejected { p.status(AuctionFixtures.change(AuctionFixtures.status(), "status", JsonPrimitive("finalized"))) }
        val terminal = AuctionFixtures.change(AuctionFixtures.change(AuctionFixtures.status(), "status", JsonPrimitive("finalized")), "slot", JsonPrimitive("4"))
        assertEquals("finalized", p.status(terminal).status)
        rejected { p.status(AuctionFixtures.change(terminal, "error", JsonPrimitive("CHAIN_TRANSACTION_FAILED"))) }
    }
    @Test fun `signature must decode to64 nonzero bytes`() {
        listOf("1".repeat(64), "2".repeat(64), "not a signature").forEach { value ->
            rejected { p.status(AuctionFixtures.change(AuctionFixtures.status(), "signature", JsonPrimitive(value))) }
        }
    }
    @Test fun `refunds keep numeric order across different string lengths`() {
        val page = p.refunds(AuctionFixtures.refunds()); assertEquals(listOf("10", "11"), page.entries.map { it.round })
        assertEquals("9007199254740993", page.entries.first().amountRaw)
    }
    @Test fun `refunds reject duplicates reverse order fixture and fake continuation`() {
        val raw = AuctionFixtures.refunds(); val rows = raw.getValue("entries").jsonArray
        rejected { p.refunds(AuctionFixtures.change(raw, "entries", JsonArray(rows.reversed()))) }
        rejected { p.refunds(AuctionFixtures.change(raw, "entries", JsonArray(listOf(rows[0], rows[0])))) }
        rejected { p.refunds(AuctionFixtures.change(raw, "source", JsonPrimitive("fixture"))) }
        rejected { p.refunds(AuctionFixtures.change(raw, "nextCursor", buildJsonObject { put("round", "12"); put("spot", 0) })) }
    }
    @Test fun `refund page size is injected and system address is rejected`() {
        rejected { SeekerAuctionProtocol(AuctionFixtures.policy.copy(refundPageSize = 1)).refunds(AuctionFixtures.refunds()) }
        rejected { p.refunds(AuctionFixtures.change(AuctionFixtures.refunds(), "mint", JsonPrimitive("1".repeat(32)))) }
    }
}
