package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ReferralsTest {
    private val wallet = "1".repeat(32)
    private val other = "2".repeat(32)
    private fun raw(value: String) = Json.parseToJsonElement(value).jsonObject
    private val relation get() = raw("""{"id":"00000000-0000-4000-8000-000000000001","refereeWallet":"$wallet","referrerWallet":"$other","createdAt":"2026-09-13T00:00:00.000Z"}""")
    @Test fun `code normalization matches the shared trim uppercase and UTF16 wire bounds`() {
        assertEquals("KEEP-AB234", ReferralCode.normalize(" \tkeep-ab234\n"))
        assertEquals("KEEP-AB234", ReferralCode.normalize("\ufeff\u00a0keep-ab234\u2028"))
        assertEquals("KEEP-SS123", ReferralCode.normalize("keep-ß123"))
        for (code in listOf("tiny", "A".repeat(17), " \n ")) assertTrue(runCatching { ReferralCode.normalize(code) }.isFailure)
    }
    @Test fun `unbound is an observation and cannot be upgraded into applied`() {
        val value = raw("""{"version":1,"wallet":"$wallet","relationship":null}""")
        assertNull(ReferralStatus.from(value).relationship)
        assertTrue(runCatching { ReferralStatus.from(JsonObject(value + ("version" to JsonPrimitive("1")))) }.isFailure)
        assertTrue(runCatching { ReferralStatus.from(JsonObject(value - "relationship")) }.isFailure)
    }
    @Test fun `relationship identity addresses and time must remain authoritative`() {
        assertEquals(other, ReferralRelationship.from(relation).referrer)
        for ((key, value) in listOf("id" to "bad", "referrerWallet" to wallet, "refereeWallet" to "bad", "createdAt" to "yesterday")) {
            assertTrue(runCatching { ReferralRelationship.from(JsonObject(relation + (key to JsonPrimitive(value)))) }.isFailure)
        }
    }
    @Test fun `status and use refuse a relationship belonging to another wallet`() {
        val status = buildJsonObject { put("version", 1); put("wallet", other); put("relationship", relation) }
        assertTrue(runCatching { ReferralStatus.from(status) }.isFailure)
        assertTrue(runCatching { ReferralUseResult.from(JsonObject(status + mapOf("submittedCode" to JsonPrimitive("KEEP-AB234"), "outcome" to JsonPrimitive("applied")))) }.isFailure)
    }
    @Test fun `already bound remains distinct from the submitted code succeeding`() {
        val response = buildJsonObject { put("version", 1); put("wallet", wallet); put("submittedCode", "KEEP-AB234"); put("outcome", "already_bound"); put("relationship", relation) }
        assertEquals("already_bound", ReferralUseResult.from(response).outcome)
        for ((key, value) in listOf("outcome" to "success", "submittedCode" to " keep-ab234 ")) {
            assertTrue(runCatching { ReferralUseResult.from(JsonObject(response + (key to JsonPrimitive(value)))) }.isFailure)
        }
        assertTrue(runCatching { ReferralUseResult.from(JsonObject(response + ("key" to JsonPrimitive("unexpected")))) }.isFailure)
    }
}
