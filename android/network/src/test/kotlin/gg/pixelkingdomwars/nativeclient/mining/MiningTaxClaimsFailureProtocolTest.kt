package gg.pixelkingdomwars.nativeclient.mining

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner failure assertions over actual public signed packets; no chain proof is invented. */
class MiningTaxClaimsFailureProtocolTest {
    private fun recovery(mode: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax/recovery.json")).readText()).jsonObject.getValue(mode).jsonObject
    private fun fixture(mode: String = "claim", ordinals: List<Int> = listOf(0)): JsonObject {
        val raw = recovery(mode); val p = raw.getValue("preparation").jsonObject; val i = p.getValue("identity").jsonObject; val s = p.getValue("source").jsonObject
        val slot = maxOf(s.getValue("snapshotSlot").jsonPrimitive.long, s.getValue("blockhashSlot").jsonPrimitive.long) + 1
        return buildJsonObject {
            put("recovery", JsonObject(raw + mapOf("status" to JsonPrimitive("signed"), "settlement" to JsonNull)))
            putJsonArray("failures") { for (ordinal in ordinals) {
                val w = raw.getValue("wires").jsonArray.first { it.jsonObject.getValue("ordinal").jsonPrimitive.int == ordinal }.jsonObject
                add(buildJsonObject {
                    for (key in listOf("wallet", "idempotencyKey", "claimId")) put(key, p.getValue(key))
                    put("ordinal", ordinal); put("verifiedAt", "2020-01-01T00:00:00.000000Z"); put("transactionFailed", true); put("claimFinalized", false)
                    putJsonObject("receipt") {
                        put("version", 1); for (key in listOf("wallet", "idempotencyKey", "claimId", "round", "spot")) put(key, p.getValue(key))
                        put("ordinal", ordinal); for (key in listOf("kind", "signature", "messageSha256")) put(key, w.getValue(key))
                        put("signedTransactionSha256", w.getValue("wireSha256")); put("slot", slot); put("blockTime", p.getValue("snapshot").jsonObject.getValue("unixTimestamp").jsonPrimitive.long)
                        put("feeLamports", "18446744073709551615"); put("rentLamports", "0"); put("paidKeepBaseUnits", "0")
                        put("outcome", "failed"); put("finalityAuthenticated", true)
                        for (key in listOf("paymentAuthorized", "signingAuthorized", "broadcastAuthorized", "journalClearingAuthorized")) put(key, false)
                        putJsonObject("source") {
                            put("trust", "trusted-finalized-rpc-reviewed-program")
                            for (key in listOf("genesisHash", "programId", "configAddress")) put(key, i.getValue(key))
                            for (key in listOf("reviewedDeploymentSlot", "reviewedProgramDataSha256", "snapshotSha256", "snapshotSlot", "blockhashSlot")) put(key, s.getValue(key))
                            put("observedAccountSlot", slot + 1)
                        }
                    }
                })
            } }
        }
    }
    private fun change(raw: JsonElement, path: String, value: JsonElement): JsonElement {
        val head = path.substringBefore('.'); val tail = path.substringAfter('.', "")
        return when (raw) {
            is JsonObject -> JsonObject(raw + (head to if (tail.isEmpty()) value else change(raw.getValue(head), tail, value)))
            is JsonArray -> JsonArray(raw.toMutableList().also { it[head.toInt()] = if (tail.isEmpty()) value else change(it[head.toInt()], tail, value) })
            else -> error("Test path")
        }
    }
    private fun parse(raw: JsonObject = fixture()) = MiningTaxClaimsFailureEnvelope.from(raw)
    private fun refuse(raw: JsonElement) { assertTrue(runCatching { parse(raw.jsonObject) }.isFailure) }
    @Test fun `five actual signed packet fixtures preserve uncapped failure fees and false client permissions`() {
        for (mode in listOf("claim", "combined", "split", "setup", "aboveQuote")) {
            val value = parse(fixture(mode)); assertEquals("18446744073709551615", value.failures[0].receipt.feeLamports)
            assertFalse(value.failures[0].claimFinalized); assertFalse(value.failures[0].receipt.journalClearingAuthorized)
        }
    }
    @Test fun `sparse failed claim and two failed ordinals do not manufacture setup success`() {
        val raw = fixture("split", listOf(1)); val wires = raw.getValue("recovery").jsonObject.getValue("wires").jsonArray
        val value = parse(change(raw, "recovery.wires", JsonArray(wires.drop(1))).jsonObject); assertNull(value.recovery.settlement)
        assertEquals(2, parse(fixture("split", listOf(0, 1))).failures.size)
    }
    @Test fun `verified setup may precede claim failure but cannot overlap any failed ordinal`() {
        assertNotNull(parse(change(fixture("split", listOf(1)), "recovery", recovery("setup")).jsonObject).recovery.settlement)
        refuse(change(fixture("split"), "recovery", recovery("setup")))
        refuse(change(fixture("split", listOf(1)), "recovery", recovery("split")))
    }
    @Test fun `actor packet source clocks and receipt authority must equal the immutable preparation`() {
        val other = recovery("combined").getValue("wallet")
        val receiptChanges = listOf("wallet" to other, "claimId" to JsonPrimitive("00000000-0000-4000-8000-000000000099"), "round" to JsonPrimitive("999"), "spot" to JsonPrimitive(255),
            "ordinal" to JsonPrimitive(1), "kind" to JsonPrimitive("setup"), "signature" to recovery("combined").getValue("wires").jsonArray[0].jsonObject.getValue("signature"),
            "messageSha256" to JsonPrimitive("ab".repeat(32)), "signedTransactionSha256" to JsonPrimitive("ab".repeat(32)), "slot" to JsonPrimitive(0), "blockTime" to JsonPrimitive(0),
            "rentLamports" to JsonPrimitive("1"), "paidKeepBaseUnits" to JsonPrimitive("1"), "feeLamports" to JsonPrimitive("018"), "feeLamports" to JsonPrimitive("18446744073709551616"), "extra" to JsonPrimitive(true))
        for ((key, value) in receiptChanges) refuse(change(fixture(), "failures.0.receipt.$key", value))
        for (key in listOf("paymentAuthorized", "signingAuthorized", "broadcastAuthorized", "journalClearingAuthorized")) refuse(change(fixture(), "failures.0.receipt.$key", JsonPrimitive(true)))
        for ((key, value) in listOf("configAddress" to other, "snapshotSha256" to JsonPrimitive("ab".repeat(32)), "snapshotSlot" to JsonPrimitive(0), "blockhashSlot" to JsonPrimitive(0), "observedAccountSlot" to JsonPrimitive(0), "reviewedDeploymentSlot" to JsonPrimitive(0))) refuse(change(fixture(), "failures.0.receipt.source.$key", value))
    }
    @Test fun `strict types canonical timestamps bounded arrays and ordered failures are mandatory`() {
        for ((path, value) in listOf("failures.0.ordinal" to JsonPrimitive("0"), "failures.0.claimFinalized" to JsonPrimitive(true), "failures.0.transactionFailed" to JsonPrimitive("true"),
            "failures.0.verifiedAt" to JsonPrimitive("2020-02-30T00:00:00.000000Z"), "failures.0.receipt.slot" to JsonPrimitive(9_007_199_254_740_992L))) refuse(change(fixture(), path, value))
        val failures = fixture().getValue("failures").jsonArray; refuse(change(fixture(), "failures", JsonArray(List(3) { failures[0] })))
        refuse(change(fixture(), "failures", JsonArray(listOf(failures[0], failures[0]))))
    }
    @Test fun `empty historical read is allowed but no failure can lack original custody`() {
        val raw = fixture(); val r = raw.getValue("recovery").jsonObject
        val unknown = JsonObject(r + mapOf("status" to JsonPrimitive("unknown"), "claimId" to JsonNull, "preparation" to JsonNull, "wires" to JsonArray(emptyList())))
        assertTrue(parse(buildJsonObject { put("recovery", unknown); put("failures", JsonArray(emptyList())) }).failures.isEmpty())
        refuse(change(raw, "recovery", unknown))
    }
    @Test fun `decoded failure and adjacent recovery collections are immutable`() {
        val value = parse(fixture("split", listOf(0, 1)))
        assertThrows(UnsupportedOperationException::class.java) { (value.failures as MutableList).clear() }
        assertThrows(UnsupportedOperationException::class.java) { (value.recovery.wires as MutableList).clear() }
    }
}
