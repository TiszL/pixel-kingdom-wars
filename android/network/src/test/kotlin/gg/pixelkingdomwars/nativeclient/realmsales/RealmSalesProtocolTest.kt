package gg.pixelkingdomwars.nativeclient.realmsales

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Exported from the browser's SDK/Anchor fixture; all chain authority is synthetic. */
class RealmSalesProtocolTest {
    private val fixture get() = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/realm-sales/settlement.json")).readText()).jsonObject
    private val policy get() = RealmSalesProtocolPolicy.from(fixture.getValue("policy").jsonObject)
    private val preparation get() = fixture.getValue("preparation").jsonObject
    private val wire get() = fixture.getValue("wire").jsonObject
    private val review get() = fixture.getValue("review").jsonObject
    private val settlement get() = fixture.getValue("settlement").jsonObject
    private fun change(raw: JsonObject, path: String, value: JsonElement): JsonObject {
        val head = path.substringBefore('.'); val tail = path.substringAfter('.', "")
        return JsonObject(raw + (head to if (tail.isEmpty()) value else change(raw.getValue(head).jsonObject, tail, value)))
    }
    private fun rejects(block: () -> Unit) = assertTrue("Untrusted document must be refused", runCatching(block).isFailure)
    private fun p(raw: JsonObject = preparation) = RealmSalePreparation.from(raw, policy)
    private fun w(raw: JsonObject = wire) = RealmSaleSignedWire.from(raw)
    private fun r(raw: JsonObject = review) = RealmSaleReview.from(p(), raw, policy)
    private fun s(raw: JsonObject = settlement) = RealmSaleSettlement.from(p(), w(), raw, policy)

    @Test fun `actual fixture parses as historical consistency without granting action authority`() {
        val prepared = p(); val measured = r(); val settled = s()
        assertEquals(prepared.saleId, measured.saleId); assertEquals(prepared.saleId, settled.saleId)
        assertTrue(settled.purchaseFinalized)
        assertFalse(prepared.currentSigningAuthorized); assertFalse(prepared.submissionAuthorized)
        assertFalse(measured.signingAuthorized); assertFalse(measured.paymentAuthorized); assertFalse(measured.submissionAuthorized); assertFalse(measured.reservation)
        assertFalse(settled.admissionAuthorized); assertFalse(settled.relayAuthorized); assertFalse(settled.signingAuthorized)
    }
    @Test fun `preparation rejects forged cost caps bad UTC windows and source slot regressions`() {
        for ((path, value) in listOf("quote.requiredLamports" to "1", "quote.paymentDebitLamports" to "0", "quote.rentLamports" to "0",
            "terms.validUntil" to "0", "terms.day" to "18446744073709551615")) rejects { p(change(preparation, path, JsonPrimitive(value))) }
        rejects { p(change(preparation, "source.admissionSlot", JsonPrimitive(0))) }
        rejects { p(change(preparation, "quote.needsAccess", JsonPrimitive(!p().quote.needsAccess))) }
        rejects { p(change(preparation, "quote.packetBytes", JsonPrimitive(66))) }
    }
    @Test fun `strict scalar shape numeric bounds and full exact keys reject coercion or added authority`() {
        rejects { p(change(preparation, "spot", JsonPrimitive("0"))) }
        rejects { p(change(preparation, "spot", JsonPrimitive(-1))) }
        rejects { p(change(preparation, "realm", JsonPrimitive(policy.realmCount))) }
        rejects { p(change(preparation, "source.feeSlot", JsonPrimitive(9_007_199_254_740_992L))) }
        rejects { p(change(preparation, "terms.round", JsonPrimitive("18446744073709551616"))) }
        rejects { p(change(preparation, "terms.validAfter", JsonPrimitive("9223372036854775808"))) }
        rejects { p(change(preparation, "terms.round", JsonPrimitive("01"))) }
        rejects { p(change(preparation, "currentSigningAuthorized", JsonPrimitive(true))) }
        rejects { p(JsonObject(preparation + ("finalityVerified" to JsonPrimitive(true)))) }
        rejects { p(JsonObject(preparation - "submissionAuthorized")) }
    }
    @Test fun `original request envelope binds actor and key including absent original recovery`() {
        val raw = buildJsonObject { put("wallet", p().wallet); put("idempotencyKey", p().idempotencyKey); put("preparation", preparation) }
        assertEquals(p(), RealmSalePreparationEnvelope.from(raw, policy).preparation)
        rejects { RealmSalePreparationEnvelope.from(change(raw, "idempotencyKey", JsonPrimitive("00000000-0000-4000-8000-000000000001")), policy) }
        assertNull(RealmSalePreparationEnvelope.from(change(raw, "preparation", JsonNull), policy).preparation)
        rejects { RealmSalePrepareRequest.from(buildJsonObject { put("idempotencyKey", p().idempotencyKey.uppercase()); put("spot", 0); put("realm", 0) }, policy) }
    }
    @Test fun `review cannot rewrite request terms or exceed original fee rent and block bounds`() {
        for ((path, value) in listOf("saleId" to "ab".repeat(16), "messageSha256" to "00".repeat(32), "sourceRevision" to "other",
            "validUntil" to "0", "paymentDebitLamports" to "0", "unixTimestamp" to "0")) rejects { r(change(review, path, JsonPrimitive(value))) }
        rejects { r(change(review, "quoteSlot", JsonPrimitive(0))) }
        rejects { r(change(review, "blockHeight", JsonPrimitive(p().quote.lastValidBlockHeight + 1))) }
        for (field in listOf("signingAuthorized", "paymentAuthorized", "submissionAuthorized", "reservation")) rejects { r(change(review, field, JsonPrimitive(true))) }
        rejects { r(change(review, "admissionEligible", JsonPrimitive(false))) }
    }
    @Test fun `owner settlement binds actor message wire deployment and ordered proof accounts`() {
        for ((path, value) in listOf("saleId" to "cd".repeat(16), "receipt.originalMessageSha256" to "00".repeat(32),
            "receipt.signedTransactionSha256" to "00".repeat(32), "receipt.source.genesisHash" to "11111111111111111111111111111111",
            "receipt.source.reviewedProgramDataSha256" to "00".repeat(32), "purchase.round" to "0", "purchase.day" to "0"))
            rejects { s(change(settlement, path, JsonPrimitive(value))) }
        rejects { s(change(settlement, "receipt.slot", JsonPrimitive(p().source.reviewedDeploymentSlot))) }
        rejects { s(change(settlement, "receipt.observedAccountSlot", JsonPrimitive(0))) }
        val accounts = settlement.getValue("receipt").jsonObject.getValue("source").jsonObject.getValue("accounts").jsonArray
        rejects { s(change(settlement, "receipt.source.accounts", JsonArray(accounts.reversed()))) }
        rejects { s(change(settlement, "receipt.source.accounts", JsonArray(accounts.toMutableList().also { it[5] = it[3] }))) }
    }
    @Test fun `settlement rejects changed coverage split cost caps and fabricated authority`() {
        for ((path, value) in listOf("purchase.coverageStart" to "0", "purchase.expiresAt" to "0", "purchase.priorExpiry" to "1",
            "purchase.priceLamports" to "1", "purchase.sellerLamports" to "0", "purchase.developerLamports" to "0", "receipt.actualRentLamports" to "0",
            "receipt.buyerNetPaymentLamports" to "0", "receipt.proofClockUnixTimestamp" to "0")) rejects { s(change(settlement, path, JsonPrimitive(value))) }
        for (field in listOf("admissionAuthorized", "relayAuthorized", "signingAuthorized")) rejects { s(change(settlement, field, JsonPrimitive(true))) }
        rejects { s(change(settlement, "purchaseFinalized", JsonPrimitive(false))) }
        rejects { s(change(settlement, "settledAt", JsonPrimitive("2026-02-30T12:34:56.123456Z"))) }
        rejects { s(change(settlement, "settledAt", JsonPrimitive("2026-09-25T12:34:56.123Z"))) }
    }
    @Test fun `syntactically valid receipt bytes and declared hashes remain attestations not cryptographic proof`() {
        // This layer deliberately does not recompute hashes, decode receipt ABI, derive PDAs, or establish finality.
        assertEquals("ab".repeat(294), s(change(settlement, "receipt.receiptAccountHex", JsonPrimitive("ab".repeat(294)))).receipt.receiptAccountHex)
        val changed = change(settlement, "receipt.source.upgradeAuthority", JsonPrimitive("11111111111111111111111111111111"))
        assertNotNull(s(changed).receipt.source.upgradeAuthority)
    }
    @Test fun `array and string bounds are checked before element traversal and decoded collections cannot mutate`() {
        rejects { p(change(preparation, "quote.rents", JsonArray(List(4) { JsonNull }))) }
        rejects { s(change(settlement, "receipt.source.accounts", JsonArray(List(7) { JsonNull }))) }
        rejects { s(change(settlement, "receipt.accountRentIncreases", JsonArray(List(4) { JsonNull }))) }
        rejects { p(change(preparation, "quote.messageHex", JsonPrimitive("01".repeat(1168)))) }
        rejects { w(change(wire, "signedTransactionHex", JsonPrimitive("01".repeat(1233)))) }
        rejects { p(change(preparation, "source.revision", JsonPrimitive("a".repeat(129)))) }
        val raw = preparation.toMutableMap(); val owned = p(JsonObject(raw)); raw["wallet"] = JsonPrimitive("bad")
        assertEquals(p().wallet, owned.wallet)
        rejects { (owned.quote.rents as MutableList).clear() }
        rejects { (s().receipt.source.accounts as MutableList).clear() }
        rejects { (s().receipt.accountRentIncreases as MutableList).clear() }
    }
    @Test fun `wire envelope rejects zero signature changed message and noncanonical lower case hex`() {
        rejects { w(change(wire, "signature", JsonPrimitive("1".repeat(64)))) }
        rejects { w(change(wire, "signedTransactionHex", JsonPrimitive("01" + "00".repeat(64) + p().quote.messageHex))) }
        rejects { w(change(wire, "signedTransactionHex", JsonPrimitive(w().signedTransactionHex.uppercase()))) }
        val changed = w(change(wire, "signedTransactionHex", JsonPrimitive(w().signedTransactionHex.dropLast(2) + "ab")))
        rejects { RealmSaleSettlement.from(p(), changed, settlement, policy) }
        rejects { w(change(wire, "acceptedAt", JsonPrimitive("2026-09-25T12:34:56.123456+00:00"))) }
    }
}
