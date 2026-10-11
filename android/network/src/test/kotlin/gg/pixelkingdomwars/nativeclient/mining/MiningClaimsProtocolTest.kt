package gg.pixelkingdomwars.nativeclient.mining

import java.util.Base64
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class MiningClaimsProtocolTest {
    private val policy = MiningClaimsProtocolPolicy(9, 1, 120)
    private val wallet = "11111111111111111111111111111111"
    private val other = "11111111111111111111111111111112"
    private val signature = "1".repeat(63) + "2"
    private val now = "2035-01-01T00:00:00.000Z"
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun rejects(block: () -> Unit) = assertTrue(runCatching(block).isFailure)
    private inline fun <reified T> raw(value: T) = miningClaimsJson.encodeToJsonElement(value).jsonObject
    private fun preparation() = MiningClaimPreparationView(1, wallet, id(1), id(2), id(2), 1, "1", "1", "ab".repeat(32), "80",
        MiningClaimIdentity(wallet, wallet, wallet, other, other), MiningClaimLeaf(wallet, "1", "80", "1", "1"), emptyList(), true, true,
        MiningClaimFees("5000", "10000", "15000", "90000"), listOf(MiningClaimTransaction(0, "combined", "legacy", "AQ==", emptyList(), wallet, other, 200, "5000", "10000")),
        now, "2035-01-01T00:02:00.000Z", now, "prepared", false, false)
    private fun status() = MiningClaimStatusView(MiningClaimFeatures(MiningClaimFeature(1, 1)), wallet, "shardkeep-economy", wallet, other,
        "ready", null, "1", "80", "0", "80", 9, 200, "7200", "7200", true, true, true, false, now)
    private fun claim() = MiningClaimView(1, wallet, id(2), "settled", "finalized", signature, "80",
        listOf(MiningClaimLanding(0, "combined", signature, "finalized", "80", now, now)), now, false)

    @Test fun `exact server DTOs roundtrip without numeric coercion or ignored fields`() {
        val p = preparation(); assertEquals(p, MiningClaimPreparationView.from(raw(p), policy)); assertEquals(status(), MiningClaimStatusView.from(raw(status()), policy))
        assertEquals(claim(), MiningClaimView.from(raw(claim())))
        rejects { MiningClaimPreparationView.from(JsonObject(raw(p) + ("quoteVersion" to JsonPrimitive("1"))), policy) }
        rejects { MiningClaimPreparationView.from(JsonObject(raw(p) + ("currentSigningAuthorized" to JsonPrimitive("false"))), policy) }
        rejects { MiningClaimPreparationView.from(JsonObject(raw(p) + ("sourceAuthority" to JsonPrimitive(true))), policy) }
        rejects { MiningClaimStatusView.from(JsonObject(raw(status()) - "reason"), policy) }
        rejects { MiningClaimStatusView.from(JsonObject(raw(status()) + ("wallet" to JsonPrimitive(1))), policy) }
    }
    @Test fun `unavailable never becomes zero and known state algebra must match`() {
        val unknown = status().copy(programId = null, keepMint = null, state = "unavailable", reason = "DISABLED", rootSequence = null,
            cumulativeKeepBaseUnits = null, claimedBaseUnits = null, claimableBaseUnits = null, observedSlot = null, chainUnixTimestamp = null,
            claimableAfterUnixTimestamp = null, needsAta = null, needsMinerRecords = null, preparationAllowed = false)
        assertNull(MiningClaimStatusView.from(raw(unknown), policy).claimableBaseUnits)
        rejects { unknown.copy(claimableBaseUnits = "0").validate(policy) }; rejects { unknown.copy(reason = null).validate(policy) }
        status().copy(state = "delayed", chainUnixTimestamp = "7199", preparationAllowed = false).validate(policy)
        rejects { status().copy(state = "delayed", preparationAllowed = false).validate(policy) }
        rejects { status().copy(claimedBaseUnits = "1").validate(policy) }
        rejects { status().copy(decimals = 6).validate(policy) }
        status().copy(state = "no_allocation", preparationAllowed = false, cumulativeKeepBaseUnits = null, claimedBaseUnits = null,
            claimableBaseUnits = "0", claimableAfterUnixTimestamp = null, needsAta = null, needsMinerRecords = null).validate(policy)
        status().copy(state = "revoked", preparationAllowed = false, cumulativeKeepBaseUnits = null, claimedBaseUnits = null,
            claimableBaseUnits = null, claimableAfterUnixTimestamp = null, needsAta = null, needsMinerRecords = null).validate(policy)
    }
    @Test fun `decimal u64 bounds reject malformed oversized and floating amounts before conversion`() {
        val p = preparation()
        for (bad in listOf("-1", "01", "1.0", "1e3", "18446744073709551616", "9".repeat(50000)))
            rejects { p.copy(fees = p.fees.copy(feeLamports = bad)).validate(policy) }
        status().copy(cumulativeKeepBaseUnits = "18446744073709551615", claimableBaseUnits = "18446744073709551615").validate(policy)
        rejects { MiningClaimStatusView.from(JsonObject(raw(status()) + ("cumulativeKeepBaseUnits" to JsonPrimitive(80))), policy) }
    }
    @Test fun `quote binds wallet request sequence exact setup order and complete fee totals`() {
        val p = preparation()
        for (bad in listOf(p.copy(quoteId = id(3)), p.copy(wallet = other), p.copy(rootSequence = "2"), p.copy(expiresAt = "2035-01-01T00:02:01.000Z"),
            p.copy(fees = p.fees.copy(totalLamports = "14999")), p.copy(fees = p.fees.copy(payerBalanceLamports = "14999")),
            p.copy(leaf = p.leaf.copy(cumulativeKeepBaseUnits = "81")), p.copy(leaf = p.leaf.copy(cumulativeRenown = "2")),
            p.copy(transactions = listOf(p.transactions.single().copy(feePayer = other))), p.copy(transactions = listOf(p.transactions.single().copy(ordinal = 1))),
            p.copy(transactions = listOf(p.transactions.single().copy(kind = "claim"))))) rejects { bad.validate(policy) }
        val split = p.copy(fees = p.fees.copy(feeLamports = "10000", totalLamports = "20000"), transactions = listOf(p.transactions.single().copy(kind = "setup"), p.transactions.single().copy(ordinal = 1, kind = "claim", rentLamports = "0")))
        split.validate(policy); rejects { split.copy(transactions = split.transactions.reversed()).validate(policy) }
        rejects { split.copy(transactions = split.transactions.mapIndexed { i, t -> if (i == 1) t.copy(blockhash = wallet) else t }).validate(policy) }
    }
    @Test fun `message signature timestamp and proof bounds reject ambiguity`() {
        val p = preparation(); p.copy(preparedAt = "2035-01-01T00:00:00.000123Z", expiresAt = "2035-01-01T00:02:00.000123Z").validate(policy)
        for (bad in listOf("AQ", "AR==", "!!!!", Base64.getEncoder().encodeToString(ByteArray(1168)))) rejects { p.copy(transactions = listOf(p.transactions.single().copy(message = bad))).validate(policy) }
        rejects { p.copy(proof = List(17) { MiningClaimProofNode("ab".repeat(32), "0", false) }).validate(policy) }
        rejects { p.copy(transactions = listOf(p.transactions.single().copy(lookupTables = listOf(MiningClaimLookupTable(wallet,wallet,false,"00".repeat(152),1))))).validate(policy) }
        rejects { p.copy(serverNow = "2035-02-30T00:00:00.000Z").validate(policy) }; rejects { p.copy(wallet = "0".repeat(32)).validate(policy) }
        rejects { claim().copy(signature = "1".repeat(64)).validate() }
        rejects { MiningClaimPreparationView.from(JsonObject(raw(p) + ("proof" to JsonArray(List(10000) { JsonNull }))), policy) }
    }
    @Test fun `immutable quote comparison permits only observation time refresh`() {
        val p = preparation(); assertTrue(p.sameOriginal(p.copy(serverNow = "2035-01-01T00:00:01.000Z"), policy))
        assertFalse(p.sameOriginal(p.copy(idempotencyKey = id(4)), policy)); assertFalse(p.sameOriginal(p.copy(root = "cd".repeat(32)), policy))
        val fees = p.fees.copy(feeLamports = "5001", totalLamports = "15001")
        assertFalse(p.sameOriginal(p.copy(fees = fees, transactions = listOf(p.transactions.single().copy(feeLamports = "5001"))), policy))
    }
    @Test fun `by key envelope cannot substitute another wallet key receipt or clock`() {
        val p = preparation(); val e = MiningClaimPreparationEnvelope(wallet, p.idempotencyKey, "prepared", p, now)
        assertEquals(e, MiningClaimPreparationEnvelope.from(raw(e), policy)); e.copy(status = "unknown", receipt = null).validate(policy)
        for (bad in listOf(e.copy(wallet = other), e.copy(idempotencyKey = id(5)), e.copy(status = "unknown"), e.copy(serverNow = "2035-01-01T00:00:01.000Z"))) rejects { bad.validate(policy) }
    }
    @Test fun `retention is not payment and setup receipt alone never settles a claim`() {
        val c = claim(); val pending = c.transactions.single().copy(landing = "pending", settledBaseUnits = null, settledAt = null)
        c.copy(state = "retained", landing = "pending", settledBaseUnits = null, transactions = listOf(pending)).validate()
        rejects { c.copy(state = "retained").validate() }; rejects { c.copy(settledBaseUnits = "0").validate() }
        val setup = c.transactions.single().copy(kind = "setup", settledBaseUnits = "0")
        val next = pending.copy(ordinal = 1, kind = "claim", signature = null, acceptedAt = null)
        c.copy(state = "retained", landing = "pending", settledBaseUnits = null, transactions = listOf(setup, next)).validate()
        rejects { c.copy(transactions = listOf(setup)).validate() }; rejects { c.copy(transactions = listOf(pending)).validate() }
        c.copy(state = "unknown", landing = "pending", signature = null, settledBaseUnits = null, transactions = emptyList()).validate()
    }
    @Test fun `request and submit contracts preserve canonical bodies without inferring finality`() {
        val request = MiningClaimPrepareRequest(id(1)); assertEquals(request, MiningClaimPrepareRequest.from(request.body()))
        val submit = MiningClaimSubmitRequest(id(2), Base64.getEncoder().encodeToString(ByteArray(66)))
        assertEquals(submit, MiningClaimSubmitRequest.from(submit.body()))
        rejects { submit.copy(signedTransaction = Base64.getEncoder().encodeToString(ByteArray(1233))).body() }
        for (delivery in listOf("held", "submitted", "settled")) MiningClaimSubmitResponse.from(JsonObject(raw(MiningClaimSubmitResponse(id(2), signature, now, delivery)) - "reason"))
        rejects { MiningClaimSubmitResponse.from(raw(MiningClaimSubmitResponse(id(2), signature, now, "held"))) }
        rejects { MiningClaimSubmitResponse(id(2), signature, now, "paid").validate() }
        rejects { MiningClaimSubmitResponse(id(2), signature, now, "held", "bad reason").validate() }
    }
    @Test fun `failed receipt requires signed terminal evidence and never reports a payment`() {
        val paid = claim(); val transaction = paid.transactions.single().copy(landing = "failed", settledBaseUnits = null)
        val failed = paid.copy(state = "failed", landing = "failed", settledBaseUnits = null, transactions = listOf(transaction))
        assertEquals(failed, MiningClaimView.from(raw(failed)))
        for (bad in listOf(transaction.copy(signature = null), transaction.copy(acceptedAt = null), transaction.copy(settledAt = null),
            transaction.copy(settledBaseUnits = "0"), transaction.copy(settledBaseUnits = "80")))
            rejects { failed.copy(transactions = listOf(bad)).validate() }
        for (bad in listOf(failed.copy(state = "retained"), failed.copy(landing = "pending"), failed.copy(signature = null), failed.copy(settledBaseUnits = "0"))) rejects { bad.validate() }
    }
    @Test fun `per ordinal failure preserves paid claim and waits for every persisted signed ordinal before failed archive`() {
        val setup = claim().transactions.single().copy(kind = "setup", settledBaseUnits = "0")
        val failure = setup.copy(ordinal = 1, kind = "claim", landing = "failed", settledBaseUnits = null, signature = "1".repeat(63) + "3")
        val failed = claim().copy(state = "failed", landing = "failed", signature = failure.signature, settledBaseUnits = null, transactions = listOf(setup, failure))
        failed.validate()
        rejects { failed.copy(signature = setup.signature).validate() }
        val failedSetup = setup.copy(landing = "failed", settledBaseUnits = null)
        val paidClaim = failure.copy(landing = "finalized", settledBaseUnits = "80")
        rejects { failed.copy(transactions = listOf(failedSetup, paidClaim)).validate() }
        claim().copy(transactions = listOf(failedSetup, paidClaim), signature = paidClaim.signature).validate()
        val pendingClaim = failure.copy(landing = "pending", settledAt = null)
        rejects { failed.copy(transactions = listOf(failedSetup, pendingClaim)).validate() }
        failed.copy(state = "retained", landing = "pending", transactions = listOf(failedSetup, pendingClaim)).validate()
        failed.copy(signature = failedSetup.signature, transactions = listOf(failedSetup, pendingClaim.copy(signature = null, acceptedAt = null))).validate()
        failed.copy(transactions = listOf(failedSetup, failure)).validate()
    }
}
