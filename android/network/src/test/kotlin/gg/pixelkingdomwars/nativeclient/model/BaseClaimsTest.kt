package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BaseClaimsTest {
    private val actor = "1".repeat(32); private val other = "2".repeat(32)
    private val key = "00000000-0000-4000-8000-000000000001"
    private val request = BaseClaimRequest(key, "00000000-0000-4000-8000-000000000002", "3".repeat(32))
    private fun receipt(outcome: String = "claimed") = buildJsonObject {
        put("version", 1); put("actor", actor); put("idempotencyKey", key); put("request", request.json())
        put("outcome", outcome); put("active", false)
        put("transferId", if (outcome == "claimed") JsonPrimitive(key) else JsonNull)
        put("fromWallet", if (outcome == "claimed") JsonPrimitive(other) else JsonNull)
        put("ownership", buildJsonObject { put("owner", actor); put("collection", "4".repeat(32)); put("slot", "9007199254740991") })
        put("createdAt", "2026-09-13T00:00:00.000Z")
    }
    private fun status(proof: JsonElement = JsonNull) = buildJsonObject {
        put("version", 1); put("wallet", actor); put("idempotencyKey", key); put("enabled", false); put("receipt", proof)
    }
    @Test fun `claimed and already-owned preserve original request and historical inactive state`() {
        for (outcome in listOf("claimed", "already_owned")) {
            val parsed = BaseClaimReceipt.from(receipt(outcome)); assertEquals(request, parsed.request); assertFalse(parsed.active)
            assertEquals(outcome, parsed.outcome); assertEquals(outcome == "claimed", parsed.transferId != null)
        }
        assertNotNull(BaseClaimStatus.from(status(receipt()), actor, request).receipt)
    }
    @Test fun `request refuses extra fields malformed identities uppercase keys and guessed targets`() {
        for (raw in listOf(JsonObject(request.json() + ("payment" to JsonPrimitive(true))), JsonObject(request.json() - "deedAssetId"),
            JsonObject(request.json() + ("baseId" to JsonPrimitive("not-a-base"))),
            JsonObject(request.json() + ("idempotencyKey" to JsonPrimitive("ABCDEFAB-0000-4000-8000-000000000001"))),
            JsonObject(request.json() + ("deedAssetId" to JsonPrimitive("0".repeat(32)))))) assertTrue(runCatching { BaseClaimRequest.from(raw) }.isFailure)
    }
    @Test fun `receipt enforces outcome transfer ownership and exact field types`() {
        val raw = receipt()
        for ((field, value) in listOf("version" to JsonPrimitive("1"), "active" to JsonPrimitive("false"), "outcome" to JsonPrimitive("paid"),
            "transferId" to JsonNull, "fromWallet" to JsonPrimitive(actor), "idempotencyKey" to JsonPrimitive(request.baseId),
            "createdAt" to JsonPrimitive("yesterday"), "unexpected" to JsonNull)) {
            assertTrue(field, runCatching { BaseClaimReceipt.from(JsonObject(raw + (field to value))) }.isFailure)
        }
        assertTrue(runCatching { BaseClaimReceipt.from(JsonObject(receipt("already_owned") + ("fromWallet" to JsonPrimitive(other)))) }.isFailure)
        val ownership = raw.getValue("ownership").jsonObject
        for ((field, value) in listOf("owner" to JsonPrimitive(other), "slot" to JsonPrimitive("9007199254740992"),
            "slot" to JsonPrimitive("01"), "slot" to JsonPrimitive(42))) {
            assertTrue(runCatching { BaseClaimReceipt.from(JsonObject(raw + ("ownership" to JsonObject(ownership + (field to value))))) }.isFailure)
        }
    }
    @Test fun `offer only enables its exact server candidate and never invents one from a reason`() {
        val raw = buildJsonObject { put("version", 1); put("wallet", actor); put("enabled", true); put("reason", "ok")
            put("candidate", buildJsonObject { put("baseId", request.baseId); put("deedAssetId", request.deedAssetId) }) }
        assertEquals(request.baseId, BaseClaimOffer.from(raw).candidate!!.baseId)
        for (change in listOf("enabled" to JsonPrimitive(false), "reason" to JsonPrimitive("none"), "candidate" to JsonNull)) {
            assertTrue(runCatching { BaseClaimOffer.from(JsonObject(raw + change)) }.isFailure)
        }
    }
    @Test fun `empty status is unknown while any positive proof must bind wallet key base and deed`() {
        assertNull(BaseClaimStatus.from(status(), actor, request).receipt)
        for ((wallet, original) in listOf(other to request, actor to request.copy(idempotencyKey = request.baseId),
            actor to request.copy(baseId = key), actor to request.copy(deedAssetId = other))) {
            assertTrue(runCatching { BaseClaimStatus.from(status(receipt()), wallet, original) }.isFailure)
        }
        assertTrue(runCatching { BaseClaimStatus.from(JsonObject(status() + ("cancelled" to JsonPrimitive(true))), actor, request) }.isFailure)
    }
    @Test fun `only explicit cancellation proof seals unknown and late acceptance returns its receipt`() {
        fun raw(cancelled: Boolean, proof: JsonElement) = JsonObject(status(proof) - "enabled" + ("cancelled" to JsonPrimitive(cancelled)))
        assertTrue(BaseClaimCancellation.from(raw(true, JsonNull), actor, request).cancelled)
        assertNotNull(BaseClaimCancellation.from(raw(false, receipt()), actor, request).receipt)
        for (pair in listOf(true to receipt(), false to JsonNull)) assertTrue(runCatching {
            BaseClaimCancellation.from(raw(pair.first, pair.second), actor, request)
        }.isFailure)
        assertTrue(runCatching { BaseClaimCancellation.from(raw(true, JsonNull), other, request) }.isFailure)
    }
}
