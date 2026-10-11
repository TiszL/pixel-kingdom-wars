package gg.pixelkingdomwars.nativeclient.seeker

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerShardsClaimsProtocolTest {
    private val f = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/seeker/shards-claims.json")).readText()).jsonObject
    private val policy get() = SeekerShardsClaimsPolicy.from(f.getValue("policy").jsonObject)
    private val request get() = f.getValue("request").jsonObject
    private val envelope get() = f.getValue("envelope").jsonObject
    private val receipt get() = envelope.getValue("receipt").jsonObject
    private val view get() = f.getValue("entitlements").jsonObject
    private val row get() = view.getValue("rows").jsonArray.single().jsonObject
    private val wallet get() = envelope.getValue("wallet").jsonPrimitive.content
    private fun patch(raw: JsonObject, name: String, value: JsonElement) = JsonObject(raw + (name to value))
    private fun rowPatch(name: String, value: JsonElement) = patch(view, "rows", JsonArray(listOf(patch(row, name, value))))
    private fun rejects(block: () -> Unit) { assertTrue("Contradictory SHARDS evidence must not become displayed or payable rights", runCatching(block).isFailure) }

    @Test fun `actual public fixture retains exact SHARDS ledger identity and conserved original totals`() {
        val r = SeekerShardsClaimRequest.from(request, policy)
        assertEquals(request, r.body(policy))
        val parsed = SeekerShardsClaimEnvelope.from(envelope, policy).match(wallet, r, policy)
        assertEquals("SHARDS", parsed.receipt!!.currency); assertEquals(receipt.getValue("ledgerTransactionId").jsonPrimitive.content, parsed.receipt.ledgerTransactionId)
        assertEquals("1", parsed.receipt.quantity); assertEquals("5", parsed.receipt.balanceAfter)
        val page = SeekerShardsEntitlementView.from(view, policy).match(wallet, null, policy)
        assertEquals("1", page.rows.single().dueQuantity); assertFalse(page.claimsEnabled)
        assertNull(SeekerShardsClaimEnvelope.from(patch(envelope, "receipt", JsonNull), policy).match(wallet, r, policy).receipt)
    }
    @Test fun `claim request cannot supply payout source destination owner or amounts`() {
        for ((key, value) in mapOf("quantity" to JsonPrimitive("1"), "poolTotal" to JsonPrimitive("8"), "winnerCount" to JsonPrimitive(3),
            "wallet" to JsonPrimitive(wallet), "termHash" to row.getValue("termHash"), "ledgerTransactionId" to receipt.getValue("id"), "resourceId" to JsonPrimitive("frost_quartz")))
            rejects { SeekerShardsClaimRequest.from(patch(request, key, value), policy) }
    }
    @Test fun `receipt and envelope bind authenticated recipient and every original request dimension`() {
        val parsed = SeekerShardsClaimEnvelope.from(envelope, policy); val original = SeekerShardsClaimRequest.from(request, policy)
        rejects { parsed.match("11111111111111111111111111111112", original, policy) }
        for (other in listOf(original.copy(idempotencyKey = original.baseId), original.copy(baseId = original.termId),
            original.copy(termId = original.baseId), original.copy(spotId = original.spotId + 1))) rejects { parsed.match(wallet, other, policy) }
        rejects { SeekerShardsClaimEnvelope.from(patch(envelope, "wallet", JsonPrimitive("11111111111111111111111111111112")), policy) }
    }
    @Test fun `receipt rejects invented shares counter regressions balance effects and zero payments`() {
        for ((name, value) in listOf("quantity" to "2", "quantity" to "0", "poolTotal" to "9", "previousTotal" to "3", "balanceAfter" to "6", "id" to request.getValue("baseId").jsonPrimitive.content))
            rejects { SeekerShardsClaimReceipt.from(patch(receipt, name, JsonPrimitive(value)), policy) }
        rejects { SeekerShardsClaimReceipt.from(patch(receipt, "winnerCount", JsonPrimitive(0)), policy) }
    }
    @Test fun `amounts are bounded canonical signed storage quantities and addition cannot overflow`() {
        for (amount in listOf("08", "+1", "-1", "1.0", " 1", "9223372036854775808", "9".repeat(100000)))
            rejects { SeekerShardsClaimReceipt.from(patch(receipt, "quantity", JsonPrimitive(amount)), policy) }
        rejects { SeekerShardsClaimReceipt.from(patch(patch(receipt, "balanceBefore", JsonPrimitive(Long.MAX_VALUE.toString())), "balanceAfter", JsonPrimitive("0")), policy) }
    }
    @Test fun `browse cursor binds the requested page while empty pages can retain a next position`() {
        val page = SeekerShardsEntitlementView.from(patch(view, "rows", JsonArray(emptyList())), policy).match(wallet, null, policy)
        assertEquals(row.getValue("termId").jsonPrimitive.content, page.nextCursor)
        rejects { page.match(wallet, page.nextCursor, policy) }; rejects { page.match("11111111111111111111111111111112", null, policy) }
        rejects { SeekerShardsEntitlementView.from(patch(view, "cursor", row.getValue("termId")), policy) }
        assertNull(SeekerShardsEntitlementQuery.from(buildJsonObject {}).cursor)
        rejects { SeekerShardsEntitlementQuery.from(buildJsonObject { put("cursor", JsonNull) }) }
        rejects { SeekerShardsEntitlementQuery.from(buildJsonObject { put("baseId", request.getValue("baseId")) }) }
    }
    @Test fun `term rows reject false due amounts invalid intervals and duplicate or reversed spots`() {
        for ((name, value) in listOf("dueQuantity" to "0", "claimedTotal" to "3", "poolTotal" to "9", "endsAt" to "2026-09-26T00:00:00.000Z", "startsAt" to "2026-02-30T00:00:00.000Z"))
            rejects { SeekerShardsEntitlementView.from(rowPatch(name, JsonPrimitive(value)), policy) }
        for (rows in listOf(listOf(row, row), listOf(patch(row, "spotId", JsonPrimitive(1)), row)))
            rejects { SeekerShardsEntitlementView.from(patch(view, "rows", JsonArray(rows)), policy) }
    }
    @Test fun `same term page requires exact pool equality even when floor shares happen to match`() {
        val sameShare = patch(patch(row, "spotId", JsonPrimitive(1)), "poolTotal", JsonPrimitive("7"))
        rejects { SeekerShardsEntitlementView.from(patch(view, "rows", JsonArray(listOf(row, sameShare))), policy) }
        for (key in listOf("termId", "termHash", "startsAt", "endsAt", "winnerCount", "cumulativeTotal")) {
            val value = when (key) { "termId" -> request.getValue("baseId"); "termHash" -> JsonPrimitive("b".repeat(64)); "winnerCount" -> JsonPrimitive(4); "cumulativeTotal" -> JsonPrimitive("1"); else -> JsonPrimitive("2026-09-19T00:00:00.000Z") }
            rejects { SeekerShardsEntitlementView.from(patch(view, "rows", JsonArray(listOf(row, patch(patch(row, "spotId", JsonPrimitive(1)), key, value)))), policy) }
        }
    }
    @Test fun `unavailable source is distinct from an empty successful page and carries no amounts or continuation`() {
        val unavailable = JsonObject(view + mapOf("status" to JsonPrimitive("unavailable"), "reason" to JsonPrimitive("SOURCE_INTEGRITY"), "rows" to JsonArray(emptyList()), "nextCursor" to JsonNull))
        assertEquals("unavailable", SeekerShardsEntitlementView.from(unavailable, policy).status)
        for ((key, value) in listOf("reason" to JsonNull, "rows" to view.getValue("rows"), "nextCursor" to view.getValue("nextCursor")))
            rejects { SeekerShardsEntitlementView.from(patch(unavailable, key, value), policy) }
    }
    @Test fun `strict typed fields reject raw resources authority extras invalid ledger wallet and timestamp encodings`() {
        for ((key, value) in mapOf("currency" to JsonPrimitive("KEEP"), "ledgerTransactionId" to JsonPrimitive("invalid"), "wallet" to JsonPrimitive("0".repeat(32)),
            "claimedAt" to JsonPrimitive("2026-09-25T00:00:00Z"), "sourceAuthorized" to JsonPrimitive(true), "quantity" to JsonPrimitive(1), "winnerCount" to JsonPrimitive("3")))
            rejects { SeekerShardsClaimReceipt.from(patch(receipt, key, value), policy) }
        rejects { SeekerShardsEntitlementView.from(patch(view, "claimsEnabled", JsonPrimitive("false")), policy) }
    }
    @Test fun `canonical UUID normalization matches shared contract and preserves request scope`() {
        val upper = "ABCDEF00-0000-4000-8000-000000000001"
        val parsed = SeekerShardsClaimRequest.from(patch(request, "idempotencyKey", JsonPrimitive(upper)), policy)
        assertEquals(upper.lowercase(), parsed.idempotencyKey)
        assertEquals(upper.lowercase(), SeekerShardsEntitlementQuery.from(buildJsonObject { put("cursor", upper) }).cursor)
    }
    @Test fun `canonical policy limits rows spots winners and term duration and returned rows are immutable`() {
        rejects { SeekerShardsClaimRequest.from(patch(request, "spotId", JsonPrimitive(policy.totalSpots)), policy) }
        rejects { SeekerShardsClaimReceipt.from(patch(receipt, "winnerCount", JsonPrimitive(policy.totalSpots + 1)), policy) }
        rejects { SeekerShardsEntitlementView.from(patch(view, "rows", JsonArray(List(policy.totalSpots + 1) { row })), policy) }
        rejects { SeekerShardsEntitlementView.from(view, policy.copy(operatingTermSec = policy.operatingTermSec + 1)) }
        rejects { SeekerShardsEntitlementView.from(view, policy.copy(totalSpots = 0)) }
        val rows = SeekerShardsEntitlementView.from(view, policy).rows
        rejects { (rows as MutableList).clear() }; assertEquals(1, rows.size)
    }
}
