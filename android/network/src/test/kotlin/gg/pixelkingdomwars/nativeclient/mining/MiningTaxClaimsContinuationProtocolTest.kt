package gg.pixelkingdomwars.nativeclient.mining

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningTaxClaimsContinuationProtocolTest {
    private fun raw() = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax/continuation.json")).readText()).jsonObject
    private fun change(v: JsonElement, path: String, next: JsonElement): JsonObject {
        val key = path.substringBefore('.'); val tail = path.substringAfter('.', "")
        return JsonObject(v.jsonObject + (key to if (tail.isEmpty()) next else change(v.jsonObject.getValue(key), tail, next)))
    }
    private fun parse(v: JsonObject = raw()) = MiningTaxClaimsContinuationEnvelope.from(v)
    private fun refuses(v: JsonObject) { assertTrue(runCatching { parse(v) }.isFailure) }
    @Test fun `actual owner link keeps paid setup separate from additional child caps and all permissions false`() {
        val v = parse(); val c = requireNotNull(v.continuation)
        assertEquals("6", c.parentSetup.receipt.feeLamports); assertEquals("5", c.childPreparation.fees.feeLamports)
        assertFalse(c.currentSigningAuthorized); assertFalse(c.relayAuthorized); assertFalse(c.settlementAuthorized); assertFalse(c.journalClearingAuthorized)
        val request = buildJsonObject { put("idempotencyKey", c.childPreparation.idempotencyKey); put("caps", raw().getValue("continuation").jsonObject.getValue("childPreparation").jsonObject.getValue("caps")) }
        assertEquals(c.childPreparation.caps, MiningTaxClaimsContinuationRequest.from(request).caps)
        for (extra in listOf("wallet", "parentClaimId", "height", "retryAuthorized")) assertTrue(runCatching { MiningTaxClaimsContinuationRequest.from(JsonObject(request + (extra to JsonPrimitive(true)))) }.isFailure)
    }
    @Test fun `unknown link is explicit empty history and grants no replacement`() {
        assertNull(parse(JsonObject(raw() + mapOf("status" to JsonPrimitive("unknown"), "continuation" to JsonNull))).continuation)
        refuses(change(raw(), "continuation", JsonNull)); refuses(change(raw(), "status", JsonPrimitive("unknown")))
        refuses(change(raw(), "wallet", JsonPrimitive("bad"))); refuses(change(raw(), "parentIdempotencyKey", JsonPrimitive("bad")))
    }
    @Test fun `same permanent actor term deployment and distinct child request are mandatory`() {
        val c = parse().continuation!!; val p = c.parentPreparation
        for ((path, value) in listOf("wallet" to p.identity.keepMint, "parentIdempotencyKey" to p.claimId,
            "childPreparation.idempotencyKey" to p.idempotencyKey, "childPreparation.claimId" to p.claimId, "childPreparation.blockhash" to p.blockhash,
            "childPreparation.identity.term" to p.identity.keepMint, "childPreparation.round" to "999", "expiry.reviewedProgramDataSha256" to "ab".repeat(32)))
            refuses(change(raw(), "continuation.$path", JsonPrimitive(value)))
        refuses(change(raw(), "continuation.childPreparation.term.winnerCount", JsonPrimitive(p.term.winnerCount + 1)))
        refuses(change(raw(), "continuation.parentSetup.ordinal", JsonPrimitive(1)))
    }
    @Test fun `expiry and fresh bank cannot regress height slot or observed chain clock`() {
        val c = parse().continuation!!
        for ((path, value) in listOf("expiry.blockHeight" to c.parentPreparation.lastValidBlockHeight,
            "expiry.slot" to c.parentSetup.receipt.source.observedAccountSlot - 1,
            "childPreparation.blockHeight" to c.expiry.blockHeight - 1, "childPreparation.source.firstSnapshotSlot" to c.expiry.slot - 1,
            "childPreparation.source.snapshotSlot" to c.expiry.slot - 1, "expiry.reviewedDeploymentSlot" to -1)) refuses(change(raw(), "continuation.$path", JsonPrimitive(value)))
        refuses(change(raw(), "continuation.childPreparation.snapshot.unixTimestamp", JsonPrimitive("0")))
    }
    @Test fun `strict types canonical dates bounded trees and authority reject widening`() {
        for (key in listOf("currentSigningAuthorized", "relayAuthorized", "settlementAuthorized", "journalClearingAuthorized", "nativeFinalityVerified")) refuses(change(raw(), "continuation.$key", JsonPrimitive(true)))
        for ((path, value) in listOf("version" to JsonPrimitive("1"), "createdAt" to JsonPrimitive("2026-02-30T00:00:00.000000Z"),
            "createdAt" to JsonPrimitive("2026-09-26T00:00:00.000Z"), "expiry.slot" to JsonPrimitive(9_007_199_254_740_992L),
            "childPreparation.caps.maxFeeLamports" to JsonPrimitive("01"), "childPreparation.caps.maxFeeLamports" to JsonPrimitive("9".repeat(10000)))) refuses(change(raw(), "continuation.$path", value))
    }
    @Test fun `decoded parent child and receipt collections are immutable`() {
        val c = parse().continuation!!
        assertThrows(UnsupportedOperationException::class.java) { (c.parentPreparation.transactions as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (c.childPreparation.transactions as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (c.parentSetup.receipt.transactions as MutableList).clear() }
    }
    @Test fun `continued original review is an explicit refusal compatible with historical recovery`() {
        val p = parse().continuation!!.parentPreparation
        val refused = buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("ordinal", 1); put("status", "unavailable"); put("review", JsonNull); put("reason", "CONTINUED"); put("serverNow", p.preparedAt) }
        assertNull(MiningTaxClaimsReviewResponse.from(p, refused).review)
    }
}
