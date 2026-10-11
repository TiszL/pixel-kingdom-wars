package gg.pixelkingdomwars.nativeclient.mining

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsReviewProtocolTest {
    private fun file(name: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax/$name.json")).readText()).jsonObject
    private fun p(kind: String = "combined") = MiningTaxClaimsPreparation.from(file("recovery").getValue(kind).jsonObject.getValue("preparation").jsonObject)
    private fun raw(kind: String = "combined", ordinal: Int = 0) = file("reviews").getValue("$kind$ordinal").jsonObject
    private fun change(raw: JsonObject, path: String, value: JsonElement): JsonObject {
        val head = path.substringBefore('.'); val tail = path.substringAfter('.', "")
        return JsonObject(raw + (head to if (tail.isEmpty()) value else change(raw.getValue(head).jsonObject, tail, value)))
    }
    private fun rejects(block: () -> Unit) = assertTrue(runCatching(block).isFailure)
    @Test fun `actual preparations bind ready selected reviews with no signing relay or finality authority`() {
        for (kind in listOf("claim", "combined", "split", "setup", "aboveQuote")) for (tx in p(kind).transactions) {
            val v = MiningTaxClaimsReviewResponse.from(p(kind), raw(kind, tx.ordinal.toInt()))
            assertEquals(tx.messageSha256, v.review!!.messageSha256); assertFalse(v.review.currentSigningAuthorized); assertFalse(v.review.relayAuthorized); assertFalse(v.review.settlementAuthorized)
        }
    }
    @Test fun `review binds actor key claim selected hash old blockhash and exact quote window`() {
        val p = p(); val fields = mapOf("wallet" to p.identity.keepMint, "idempotencyKey" to p.claimId, "claimId" to p.idempotencyKey, "messageSha256" to "ab".repeat(32), "blockhash" to p.identity.keepMint, "preparedAt" to "2035-01-01T00:00:00.001Z", "expiresAt" to "2035-01-01T00:02:00.001Z")
        for ((key, value) in fields) rejects { MiningTaxClaimsReviewResponse.from(p, change(raw(), "review.$key", JsonPrimitive(value))) }
        for ((key, value) in listOf("wallet" to JsonPrimitive(p.identity.keepMint), "idempotencyKey" to JsonPrimitive(p.claimId), "ordinal" to JsonPrimitive(1))) rejects { MiningTaxClaimsReviewResponse.from(p, change(raw(), key, value)) }
    }
    @Test fun `independent source pins advancing slots and bounded current height preserve old transaction`() {
        for ((key, value) in mapOf("genesisHash" to JsonPrimitive(p().identity.keepMint), "programId" to JsonPrimitive(p().identity.keepMint), "reviewedDeploymentSlot" to JsonPrimitive(1), "reviewedProgramDataSha256" to JsonPrimitive("ab".repeat(32)), "snapshotSlot" to JsonPrimitive(2002), "feeSlot" to JsonPrimitive(0), "blockHeight" to JsonPrimitive(199), "lastValidBlockHeight" to JsonPrimitive(301)))
            rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "review.source.$key", value)) }
        rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "review.source.blockHeight", JsonPrimitive(301))) }
    }
    @Test fun `selected cost plus paid setup conserves explicit caps and ordinal zero has no paid setup`() {
        var split = raw("split", 1)
        for ((key, value) in mapOf("paidFeeLamports" to "6", "feeLamports" to "4", "totalLamports" to "4")) split = change(split, "review.$key", JsonPrimitive(value))
        assertEquals("ready", MiningTaxClaimsReviewResponse.from(p("split"), split).status)
        rejects { MiningTaxClaimsReviewResponse.from(p("split"), change(change(split, "review.feeLamports", JsonPrimitive("5")), "review.totalLamports", JsonPrimitive("5"))) }
        for ((key, value) in mapOf("totalLamports" to "0", "paidFeeLamports" to "1", "paidRentLamports" to "1")) rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "review.$key", JsonPrimitive(value))) }
        val claim = change(change(raw("claim"), "review.rentLamports", JsonPrimitive("1")), "review.totalLamports", JsonPrimitive("6"))
        rejects { MiningTaxClaimsReviewResponse.from(p("claim"), claim) }
    }
    @Test fun `observed clock must precede response clock and both fit original unextended expiry`() {
        for (time in listOf("2034-12-31T23:59:59.999Z", "2035-01-01T00:00:03.000Z", p().expiresAt, "2035-02-30T00:00:01.000Z")) rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "review.observedAt", JsonPrimitive(time))) }
        for (time in listOf("2035-01-01T00:00:00.000Z", p().expiresAt, "2035-01-01T00:00:01Z")) rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "serverNow", JsonPrimitive(time))) }
    }
    @Test fun `unavailable is empty reason constrained and never an action permission`() {
        val unavailable = JsonObject(raw() + mapOf("status" to JsonPrimitive("unavailable"), "review" to JsonNull, "reason" to JsonPrimitive("DISABLED")))
        assertNull(MiningTaxClaimsReviewResponse.from(p(), unavailable).review)
        for (bad in listOf(JsonObject(unavailable - "reason"), change(unavailable, "reason", JsonNull), change(unavailable, "reason", JsonPrimitive("SEND_NOW")), change(raw(), "reason", JsonPrimitive("EXPIRED")), change(raw(), "review", JsonNull))) rejects { MiningTaxClaimsReviewResponse.from(p(), bad) }
    }
    @Test fun `strict types byte bounds and added authority fail before unsafe numeric conversion`() {
        for (value in listOf(JsonPrimitive("x"), JsonPrimitive("01"), JsonPrimitive("18446744073709551616"), JsonPrimitive("9".repeat(10000)), JsonPrimitive(1))) rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "review.feeLamports", value)) }
        for (key in listOf("currentSigningAuthorized", "relayAuthorized", "settlementAuthorized", "finalityAuthenticated")) rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "review.$key", JsonPrimitive(true))) }
        rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "ordinal", JsonPrimitive("0"))) }
        rejects { MiningTaxClaimsReviewResponse.from(p(), change(raw(), "review.source.feeSlot", JsonPrimitive(9_007_199_254_740_992L))) }
    }
    @Test fun `submit acknowledgements bind custody and null custody only preserves storage uncertainty`() {
        val r = file("recovery").getValue("combined").jsonObject
        val ack = buildJsonObject { put("wallet", r.getValue("wallet")); put("idempotencyKey", r.getValue("idempotencyKey")); put("claimId", r.getValue("claimId")); put("wire", r.getValue("wires").jsonArray[0]); put("delivery", "submitted"); put("serverNow", r.getValue("serverNow")) }
        assertNotNull(MiningTaxClaimsSubmitResponse.from(ack).wire)
        val uncertain = JsonObject(ack + mapOf("claimId" to JsonNull, "wire" to JsonNull, "delivery" to JsonPrimitive("held"), "reason" to JsonPrimitive("STORAGE_UNCERTAIN")))
        assertNull(MiningTaxClaimsSubmitResponse.from(uncertain).wire)
        for (bad in listOf(change(uncertain, "reason", JsonPrimitive("TIMEOUT")), change(uncertain, "delivery", JsonPrimitive("submitted")), change(ack, "reason", JsonPrimitive("TIMEOUT")), change(ack, "reason", JsonNull), change(ack, "wallet", JsonPrimitive(p().identity.keepMint)), change(ack, "wire.wallet", JsonPrimitive(p().identity.keepMint)), change(ack, "delivery", JsonPrimitive("setup")))) rejects { MiningTaxClaimsSubmitResponse.from(bad) }
    }
}
