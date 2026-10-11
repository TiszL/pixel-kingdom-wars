package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SkrFaucetDtoTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-api-vectors.json")
        assertNotNull("MISSING: vector from P5 frozen route-test output; mocks are not acceptance", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    @Test fun `MISSING vector real P5 bodies decode across all four routes`() {
        SkrFaucetStatus.from(vector("status"))
        SkrFaucetGrant.from(vector("claim").getValue("grant").jsonObject)
        SkrFaucetPrepared.from(vector("prepare"))
        SkrFaucetGrant.from(vector("submit").getValue("grant").jsonObject)
    }
    @Test fun `unknown reason status and phase preserve raw value and never authorize a mutation`() {
        val raw = vector("status")
        val unknown = SkrFaucetStatus.from(JsonObject(raw + ("reason" to JsonPrimitive("future_reason"))))
        assertFalse(unknown.reason.known); assertEquals("future_reason", unknown.reason.raw)
        val grant = vector("prepare").getValue("grant").jsonObject
        val attempt = grant.getValue("attempt").jsonObject
        val next = SkrFaucetGrant.from(JsonObject(grant + mapOf("status" to JsonPrimitive("future_status"),
            "attempt" to JsonObject(attempt + ("phase" to JsonPrimitive("future_phase"))))))
        assertFalse(next.status.known); assertFalse(next.attempt!!.phase.known)
    }
    @Test fun `malformed mint amount UUID and required fields fail closed`() {
        val raw = vector("claim").getValue("grant").jsonObject
        for (pair in listOf("id" to JsonPrimitive("bad"), "mint" to JsonPrimitive("0".repeat(32)),
            "amountRaw" to JsonPrimitive(1000), "amountRaw" to JsonPrimitive("1e9"), "decimals" to JsonPrimitive("6"))) {
            assertThrows(IllegalArgumentException::class.java) { SkrFaucetGrant.from(JsonObject(raw + pair)) }
        }
        assertThrows(IllegalArgumentException::class.java) { SkrFaucetGrant.from(JsonObject(raw - "mint")) }
    }
    @Test fun `fee and rent are exact decimal strings and submit attempts remain distinct from terminal grants`() {
        val raw = vector("prepare")
        val prepared = SkrFaucetPrepared.from(raw)
        assertEquals(raw.getValue("networkFeeLamports").jsonPrimitive.content, prepared.networkFeeLamports)
        assertEquals(raw.getValue("accountRentLamports").jsonPrimitive.content, prepared.accountRentLamports)
        assertThrows(IllegalArgumentException::class.java) {
            SkrFaucetPrepared.from(JsonObject(raw + ("networkFeeLamports" to JsonPrimitive(-1))))
        }
    }
    @Test fun `daily limit details expose existing grant without treating every 429 as that code`() {
        val raw = vector("claim")
        assertEquals(SkrFaucetGrant.from(raw.getValue("grant").jsonObject),
            SkrFaucetGrant.fromDailyLimit(buildJsonObject { put("today", raw.getValue("grant")) }))
    }

    @Test fun `operator settlement grant and attempt outcomes remain distinct and preserve exact wire fields`() {
        val original = vector("prepare").getValue("grant").jsonObject
        val attempt = original.getValue("attempt").jsonObject
        // Defensive DTO mutations of a required P5 vector, not captured settlement-route evidence.
        val outcomes = listOf(Triple("requested", "failed", "chain_failed"),
            Triple("failed", "failed", "max_attempts"), Triple("sent", "finalized", null))
        for ((status, phase, error) in outcomes) {
            val raw = JsonObject(original + mapOf("status" to JsonPrimitive(status),
                "error" to (error?.let(::JsonPrimitive) ?: JsonNull),
                "sentAt" to if (status == "sent") original.getValue("requestedAt") else JsonNull,
                "attempt" to JsonObject(attempt + ("phase" to JsonPrimitive(phase)))))
            val decoded = SkrFaucetGrant.from(raw)
            val decodedAttempt = requireNotNull(decoded.attempt)
            assertEquals(raw, decoded.raw); assertTrue(decoded.status.isValue(status))
            assertTrue(decodedAttempt.phase.isValue(phase)); assertEquals(error, decoded.error)
            assertEquals(original.getValue("id").jsonPrimitive.content, decoded.id)
            assertEquals(original.getValue("mint").jsonPrimitive.content, decoded.mint)
            assertEquals(original.getValue("amountRaw").jsonPrimitive.content, decoded.amountRaw)
            assertEquals(original.getValue("decimals").jsonPrimitive.int, decoded.decimals)
            assertEquals(original.getValue("requestedAt").jsonPrimitive.content, decoded.requestedAt)
            assertEquals(attempt.getValue("id").jsonPrimitive.content, decodedAttempt.id)
            assertEquals(attempt.getValue("lastValidBlockHeight").jsonPrimitive.content, decodedAttempt.lastValidBlockHeight)
            assertEquals(if (attempt["signature"] == JsonNull) null else attempt.getValue("signature").jsonPrimitive.content,
                decodedAttempt.signature)
            assertEquals(if (status == "sent") decoded.requestedAt else null, decoded.sentAt)
        }
    }

}
