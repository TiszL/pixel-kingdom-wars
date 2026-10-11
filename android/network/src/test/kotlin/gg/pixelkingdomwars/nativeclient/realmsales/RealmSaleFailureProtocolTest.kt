package gg.pixelkingdomwars.nativeclient.realmsales

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RealmSaleFailureProtocolTest {
    private fun resource(path: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResource(path)).readText()).jsonObject
    private val fixture get() = resource("/realm-sales/failure.json")
    // Existing exported canonical catalogue policy; never learned from the failure response.
    private val policy get() = RealmSalesProtocolPolicy.from(resource("/realm-sales/settlement.json").getValue("policy").jsonObject)
    private val p get() = RealmSalePreparation.from(fixture.getValue("preparation").jsonObject, policy)
    private val w get() = RealmSaleSignedWire.from(fixture.getValue("wire").jsonObject)
    private val raw get() = fixture.getValue("failure").jsonObject
    private fun change(raw: JsonObject, path: String, value: JsonElement): JsonObject {
        val head = path.substringBefore('.'); val tail = path.substringAfter('.', "")
        return JsonObject(raw + (head to if (tail.isEmpty()) value else change(raw.getValue(head).jsonObject, tail, value)))
    }
    private fun read(value: JsonObject = raw) = RealmSaleFailure.from(p, w, value, policy)
    private fun refuses(block: () -> Unit) { assertTrue("Untrusted failure must be refused", runCatching(block).isFailure) }
    @Test fun `actual public failure is owner attestation with zero purchase effects and no clearing authority`() {
        val f = read(); assertTrue(f.transactionFailed); assertFalse(f.purchaseFinalized); assertFalse(f.journalClearingAuthorized)
        assertTrue(f.receipt.finalityVerified); assertEquals("0", f.receipt.actualRentLamports); assertEquals("0", f.receipt.buyerNetPaymentLamports)
        assertFalse(f.receipt.accessChanged); assertFalse(f.receipt.quotaConsumed)
        assertFalse(f.receipt.paymentAuthorized); assertFalse(f.receipt.admissionAuthorized); assertFalse(f.receipt.signingAuthorized)
        assertFalse(f.receipt.broadcastAuthorized); assertFalse(f.receipt.journalClearingAuthorized)
    }
    @Test fun `historical fees are not capped by quote and chain time may be null negative or lag quote`() {
        assertTrue(read().receipt.blockTime!! < p.quote.unixTimestamp.toLong())
        assertEquals("18446744073709551615", read(change(raw, "receipt.feeLamports", JsonPrimitive("18446744073709551615"))).receipt.feeLamports)
        assertNull(read(change(raw, "receipt.blockTime", JsonNull)).receipt.blockTime)
        assertEquals(-1L, read(change(raw, "receipt.blockTime", JsonPrimitive(-1))).receipt.blockTime)
    }
    @Test fun `owner original sale and exact saved message wire identity cannot be substituted`() {
        for ((path, value) in listOf("wallet" to p.terms.seller, "idempotencyKey" to "00000000-0000-4000-8000-000000000001", "saleId" to "ab".repeat(16),
            "receipt.wallet" to p.terms.seller, "receipt.saleId" to "ab".repeat(16), "receipt.round" to "2", "receipt.day" to "11",
            "receipt.signature" to "2".repeat(88), "receipt.originalMessageSha256" to "ab".repeat(32), "receipt.signedTransactionSha256" to "ab".repeat(32)))
            refuses { read(change(raw, path, JsonPrimitive(value))) }
        for (path in listOf("receipt.spot", "receipt.realm")) refuses { read(change(raw, path, JsonPrimitive(1))) }
        refuses { RealmSaleFailure.from(p, w.copy(wallet = p.terms.seller), raw, policy) }
        refuses { RealmSaleFailure.from(p, w.copy(signedTransactionHex = w.signedTransactionHex.dropLast(2) + "ab"), raw, policy) }
    }
    @Test fun `source identity ordered account roles and monotonic observation slots remain exact`() {
        for ((path, value) in listOf("receipt.source.genesisHash" to p.terms.seller, "receipt.source.programId" to p.terms.seller,
            "receipt.source.reviewedProgramDataSha256" to "ab".repeat(32), "receipt.source.trust" to "untrusted", "receipt.source.stateProvenance" to "cached"))
            refuses { read(change(raw, path, JsonPrimitive(value))) }
        for ((path, value) in listOf("receipt.slot" to p.source.reviewedDeploymentSlot, "receipt.slot" to p.source.admissionSlot - 1,
            "receipt.observedAccountSlot" to 0, "receipt.source.reviewedDeploymentSlot" to 0)) refuses { read(change(raw, path, JsonPrimitive(value))) }
        val accounts = raw.getValue("receipt").jsonObject.getValue("source").jsonObject.getValue("accounts").jsonArray
        refuses { read(change(raw, "receipt.source.accounts", JsonArray(accounts.reversed()))) }
        refuses { read(change(raw, "receipt.source.accounts", JsonArray(listOf(accounts[0], accounts[0], accounts[2])))) }
        for (field in listOf("owner", "executable", "exists")) {
            val bad = change(accounts[0].jsonObject, field, if (field == "owner") JsonPrimitive(p.terms.seller) else JsonPrimitive(false))
            refuses { read(change(raw, "receipt.source.accounts", JsonArray(listOf(bad, accounts[1], accounts[2])))) }
        }
    }
    @Test fun `strict bounded numbers strings times and false authority fields reject coercion and extensions`() {
        for ((path, value) in listOf("receipt.slot" to JsonPrimitive("101"), "receipt.slot" to JsonPrimitive(9_007_199_254_740_992L),
            "receipt.blockTime" to JsonPrimitive(-9_007_199_254_740_992L), "receipt.feeLamports" to JsonPrimitive("01"),
            "receipt.feeLamports" to JsonPrimitive("18446744073709551616"), "receipt.proofClockUnixTimestamp" to JsonPrimitive("0"),
            "receipt.proofClockUnixTimestamp" to JsonPrimitive("9223372036854775808"), "receipt.proofClockUnixTimestamp" to JsonPrimitive("1"),
            "verifiedAt" to JsonPrimitive("2026-02-30T00:00:00.000000Z"), "verifiedAt" to JsonPrimitive("2026-09-26T00:00:00.000Z"),
            "receipt.actualRentLamports" to JsonPrimitive("1"), "receipt.buyerNetPaymentLamports" to JsonPrimitive("1"))) refuses { read(change(raw, path, value)) }
        for (path in listOf("purchaseFinalized", "journalClearingAuthorized", "receipt.paymentAuthorized", "receipt.admissionAuthorized", "receipt.signingAuthorized",
            "receipt.broadcastAuthorized", "receipt.journalClearingAuthorized", "receipt.accessChanged", "receipt.quotaConsumed")) refuses { read(change(raw, path, JsonPrimitive(true))) }
        for (path in listOf("transactionFailed", "receipt.transactionFailed", "receipt.finalityVerified")) refuses { read(change(raw, path, JsonPrimitive(false))) }
        refuses { read(JsonObject(raw + ("retryAllowed" to JsonPrimitive(true)))) }; refuses { read(JsonObject(raw - "purchaseFinalized")) }
    }
    @Test fun `failure GET envelope requires exact actor and key even when evidence absent`() {
        val envelope = buildJsonObject { put("wallet", p.wallet); put("idempotencyKey", p.idempotencyKey); put("failure", raw) }
        assertEquals(read(), RealmSaleFailureEnvelope.from(envelope, policy).failure)
        assertNull(RealmSaleFailureEnvelope.from(change(envelope, "failure", JsonNull), policy).failure)
        refuses { RealmSaleFailureEnvelope.from(change(envelope, "wallet", JsonPrimitive(p.terms.seller)), policy) }
        refuses { RealmSaleFailureEnvelope.from(change(envelope, "idempotencyKey", JsonPrimitive(p.idempotencyKey.uppercase())), policy) }
    }
    @Test fun `collections bounded before traversal and parsed proof metadata immutable`() {
        refuses { read(change(raw, "receipt.source.accounts", JsonArray(List(4) { JsonNull }))) }
        refuses { read(change(raw, "receipt.signature", JsonPrimitive("2".repeat(2465)))) }
        assertThrows(UnsupportedOperationException::class.java) { (read().receipt.source.accounts as MutableList).clear() }
        // Grammar deliberately cannot establish canonical PDA or actual data hash validity.
        val f = read(); val accounts = f.receipt.source.accounts.toMutableList(); accounts[1] = accounts[1].copy(address = p.terms.seller)
        f.copy(receipt = f.receipt.copy(source = f.receipt.source.copy(accounts = accounts))).validate(p, w, policy)
    }
}
