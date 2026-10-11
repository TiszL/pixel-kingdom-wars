package gg.pixelkingdomwars.nativeclient.mining

import java.util.Base64
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Actual public quote/planner/signer/finalized-reader fixtures; synthetic chain authority. */
class MiningTaxClaimsProtocolTest {
    private fun fixture(kind: String = "combined") = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/mining-tax/recovery.json")).readText()).jsonObject.getValue(kind).jsonObject
    private fun change(raw: JsonElement, path: String, value: JsonElement): JsonElement {
        val head = path.substringBefore('.'); val tail = path.substringAfter('.', "")
        fun next(old: JsonElement) = if (tail.isEmpty()) value else change(old, tail, value)
        return when (raw) {
            is JsonObject -> JsonObject(raw + (head to next(raw.getValue(head))))
            is JsonArray -> JsonArray(raw.toMutableList().also { it[head.toInt()] = next(it[head.toInt()]) })
            else -> error("invalid test path")
        }
    }
    private fun changed(raw: JsonObject, path: String, value: JsonElement) = change(raw, path, value).jsonObject
    private fun rejects(block: () -> Unit) = assertTrue("Untrusted tax document must be refused", runCatching(block).isFailure)
    private fun parse(raw: JsonObject = fixture()) = MiningTaxClaimsRecoveryEnvelope.from(raw)
    private fun p(raw: JsonObject = fixture().getValue("preparation").jsonObject) = MiningTaxClaimsPreparation.from(raw)
    private fun rejectChanges(paths: List<Pair<String, JsonElement>>, kind: String = "combined") {
        for ((path, value) in paths) rejects { parse(changed(fixture(kind), path, value)) }
    }

    @Test fun `actual claim combined split and setup fixtures preserve precise history without action authority`() {
        for (kind in listOf("claim", "combined", "split", "setup")) {
            val v = parse(fixture(kind)); val s = requireNotNull(v.settlement); val p = requireNotNull(v.preparation)
            assertEquals(kind != "setup", s.claimFinalized)
            assertTrue(s.receipt.finalityAuthenticated); assertFalse(s.receipt.journalClearingAuthorized)
            assertFalse(s.receipt.currentClaimsAuthorized); assertFalse(s.receipt.signingAuthorized); assertFalse(s.receipt.broadcastAuthorized)
            assertFalse(p.currentSigningAuthorized); assertFalse(p.submissionAuthorized)
            v.wires.forEach { assertFalse(it.currentSigningAuthorized); assertFalse(it.relayAuthorized); assertFalse(it.settlementAuthorized) }
            assertEquals("2035-01-01T00:00:02.123456Z", s.settledAt)
        }
    }
    @Test fun `finalized costs above quoted measurements remain recoverable within saved user caps`() {
        val v = parse(fixture("aboveQuote")); val p = requireNotNull(v.preparation); val r = requireNotNull(v.settlement).receipt
        assertEquals("5", p.transactions.single().feeLamports); assertEquals("6", r.feeLamports); assertEquals("10", p.caps.maxFeeLamports)
        val lower = changed(changed(fixture(), "settlement.receipt.rentLamports", JsonPrimitive("0")), "settlement.receipt.transactions.0.rentLamports", JsonPrimitive("0"))
        assertEquals("0", parse(lower).settlement!!.receipt.rentLamports)
    }
    @Test fun `unknown prepared and signed states derive only from present original evidence`() {
        val f = fixture(); val prepared = JsonObject(f + mapOf("status" to JsonPrimitive("prepared"), "wires" to JsonArray(emptyList()), "settlement" to JsonNull))
        assertEquals("prepared", parse(prepared).status)
        assertNull(parse(JsonObject(prepared + mapOf("status" to JsonPrimitive("unknown"), "claimId" to JsonNull, "preparation" to JsonNull))).preparation)
        assertEquals("signed", parse(JsonObject(f + mapOf("status" to JsonPrimitive("signed"), "settlement" to JsonNull))).status)
        for (status in listOf("unknown", "prepared", "signed", "setup")) rejects { parse(changed(f, "status", JsonPrimitive(status))) }
    }
    @Test fun `sparse signed custody cannot substitute for complete settlement prefix`() {
        val f = fixture("split"); val wires = f.getValue("wires").jsonArray
        assertEquals(1L, parse(JsonObject(f + mapOf("status" to JsonPrimitive("signed"), "settlement" to JsonNull, "wires" to JsonArray(listOf(wires[1]))))).wires.single().ordinal)
        for (bad in listOf(listOf(wires[1]), wires.reversed(), listOf(wires[0], wires[0]))) rejects { parse(changed(f, "wires", JsonArray(bad))) }
        val setup = fixture("setup")
        assertFalse(parse(changed(setup, "wires", JsonArray(listOf(setup.getValue("wires").jsonArray[0])))).settlement!!.claimFinalized)
        rejects { parse(changed(setup, "settlement.claimFinalized", JsonPrimitive(true))) }
    }
    @Test fun `owner key and claim identity bind every evidence layer`() {
        for (field in listOf("wallet", "idempotencyKey", "claimId")) {
            val value = if (field == "wallet") p().identity.keepMint else "ffffffff-ffff-4fff-8fff-ffffffffffff"
            for (prefix in listOf("", "preparation.", "wires.0.", "settlement.")) rejects { parse(changed(fixture(), prefix + field, JsonPrimitive(value))) }
        }
    }
    @Test fun `preparation rejects changed original term distribution setup and quote provenance`() {
        rejectChanges(listOf("preparation.term.auctionEnd", "preparation.term.completedAt", "preparation.intended.claimBaseUnits", "preparation.intended.cumulativeBaseUnits", "preparation.intended.dustBaseUnits", "preparation.snapshot.claimedBaseUnits").map { it to JsonPrimitive("999999999") })
        rejectChanges(listOf("preparation.source.firstSnapshotSlot", "preparation.source.blockhashSlot", "preparation.source.feeSlot", "preparation.source.snapshotSlot").map { it to JsonPrimitive(0) })
        rejectChanges(listOf("preparation.setup.needsAta" to JsonPrimitive(false), "preparation.setup.needsPool" to JsonPrimitive(true), "preparation.setup.needsCursor" to JsonPrimitive(false), "preparation.blockHeight" to JsonPrimitive(301)))
        rejects { p(changed(fixture().getValue("preparation").jsonObject, "expiresAt", JsonPrimitive("2035-01-01T00:02:01.000Z"))) }
    }
    @Test fun `saved historical terms are parsed without today's game policy`() {
        val raw = fixture().getValue("preparation").jsonObject
        val updated = changed(changed(raw, "quoteTtlSec", JsonPrimitive(121)), "expiresAt", JsonPrimitive("2035-01-01T00:02:01.000Z"))
        assertEquals(121L, p(updated).quoteTtlSec)
        assertEquals(255L, p(changed(raw, "spot", JsonPrimitive(255))).spot)
    }
    @Test fun `original packet account roster ordering and sums reject substitution`() {
        rejectChanges(listOf("preparation.transactions.0.ordinal" to JsonPrimitive(1), "preparation.transactions.0.kind" to JsonPrimitive("claim"), "preparation.transactions.0.packetBytes" to JsonPrimitive(66), "preparation.transactions.0.newAccounts.0.address" to JsonPrimitive(p().identity.pool), "preparation.transactions.0.rentLamports" to JsonPrimitive("0"), "preparation.fees.totalLamports" to JsonPrimitive("0")))
        val f = fixture("split"); val tx = f.getValue("preparation").jsonObject.getValue("transactions").jsonArray
        rejects { parse(changed(f, "preparation.transactions", JsonArray(tx.reversed()))) }
        rejects { parse(changed(f, "preparation.setup.accrualDays", JsonArray(listOf(JsonPrimitive("2"), JsonPrimitive("1"))))) }
    }
    @Test fun `wire hashes declared signatures exact bytes and receipt prefix must agree`() {
        rejectChanges(listOf("wires.0.ordinal" to JsonPrimitive(1), "wires.0.kind" to JsonPrimitive("claim"), "wires.0.messageSha256" to JsonPrimitive("ab".repeat(32)), "wires.0.wireSha256" to JsonPrimitive("ab".repeat(32)), "settlement.receipt.transactions.0.messageSha256" to JsonPrimitive("ab".repeat(32)), "settlement.receipt.transactions.0.signature" to JsonPrimitive("1".repeat(64))))
        val wire = parse().wires.single().signedTransactionHex
        for (value in listOf("01" + "ab".repeat(64) + wire.substring(130), wire.dropLast(2) + "00", wire + "00", wire.uppercase())) rejects { parse(changed(fixture(), "wires.0.signedTransactionHex", JsonPrimitive(value))) }
    }
    @Test fun `syntactically matching hash declarations do not establish cryptographic proof`() {
        var f = fixture()
        for (path in listOf("preparation.transactions.0.messageSha256", "wires.0.messageSha256", "settlement.receipt.transactions.0.messageSha256")) f = changed(f, path, JsonPrimitive("ab".repeat(32)))
        assertEquals("ab".repeat(32), parse(f).wires.single().messageSha256)
        assertFalse(parse(f).settlement!!.receipt.journalClearingAuthorized)
    }
    @Test fun `settlement binds original claimant term spot deployment and exact intended payment`() {
        rejectChanges(listOf("settlement.receipt.round" to JsonPrimitive("99"), "settlement.receipt.spot" to JsonPrimitive(1), "settlement.receipt.term" to JsonPrimitive(p().identity.keepMint), "settlement.receipt.pool" to JsonPrimitive(p().identity.keepMint), "settlement.receipt.cursor" to JsonPrimitive(p().identity.keepMint), "settlement.receipt.source.genesisHash" to JsonPrimitive(p().identity.keepMint), "settlement.receipt.source.reviewedDeploymentSlot" to JsonPrimitive(1), "settlement.receipt.source.reviewedProgramDataSha256" to JsonPrimitive("ab".repeat(32)), "settlement.receipt.paidKeepBaseUnits" to JsonPrimitive("2"), "settlement.receipt.transactions.0.claimedCumulativeBaseUnits" to JsonPrimitive("4")))
    }
    @Test fun `historical payment and observed counters must conserve high water values`() {
        rejectChanges(listOf("currentPoolAccrued", "currentPoolPaid", "currentClaimedTotal", "currentGlobalTaxPaid", "poolPaidAfterClaimBaseUnits", "globalTaxPaidAfterClaimBaseUnits").map { "settlement.receipt.transactions.0.$it" to JsonPrimitive("0") })
        rejectChanges(listOf("settlement.receipt.transactions.0.paidKeepBaseUnits" to JsonPrimitive("1")), "setup")
        rejectChanges(listOf("settlement.receipt.transactions.0.claimedCumulativeBaseUnits" to JsonPrimitive("0")), "setup")
    }
    @Test fun `receipt actual totals cannot exceed any saved explicit cap`() {
        for ((field, value) in listOf("feeLamports" to "11", "rentLamports" to "1001")) {
            val f = changed(changed(fixture(), "settlement.receipt.$field", JsonPrimitive(value)), "settlement.receipt.transactions.0.$field", JsonPrimitive(value))
            rejects { parse(f) }
        }
        rejects { parse(changed(fixture(), "preparation.caps.maxTotalLamports", JsonPrimitive("204"))) }
        rejects { parse(changed(fixture(), "settlement.receipt.feeLamports", JsonPrimitive("0"))) }
    }
    @Test fun `slots clocks and source labels cannot fabricate finality or action authority`() {
        rejectChanges(listOf("settlement.receipt.transactions.0.slot" to JsonPrimitive(2002), "settlement.receipt.transactions.0.blockTime" to JsonPrimitive(0), "settlement.receipt.source.observedAccountSlot" to JsonPrimitive(0), "settlement.receipt.source.originalTermContextSlot" to JsonPrimitive(3000), "settlement.receipt.source.observedClockUnixTimestamp" to JsonPrimitive("0"), "settlement.receipt.source.trust" to JsonPrimitive("supplied-finalized-evidence"), "settlement.receipt.finalityAuthenticated" to JsonPrimitive(false)))
        for (path in listOf("preparation.currentSigningAuthorized", "preparation.submissionAuthorized", "wires.0.currentSigningAuthorized", "wires.0.relayAuthorized", "wires.0.settlementAuthorized", "settlement.receipt.currentClaimsAuthorized", "settlement.receipt.journalClearingAuthorized", "settlement.receipt.signingAuthorized", "settlement.receipt.broadcastAuthorized")) rejects { parse(changed(fixture(), path, JsonPrimitive(true))) }
    }
    @Test fun `strict types canonical scalars calendar values and unknown fields fail closed`() {
        rejectChanges(listOf("preparation.spot" to JsonPrimitive("0"), "preparation.spot" to JsonPrimitive(-1), "preparation.spot" to JsonPrimitive(256), "preparation.source.snapshotSlot" to JsonPrimitive(9_007_199_254_740_992L), "preparation.round" to JsonPrimitive("18446744073709551616"), "preparation.term.completedAt" to JsonPrimitive("9223372036854775808"), "preparation.round" to JsonPrimitive("01"), "wallet" to JsonPrimitive("1".repeat(32)), "wallet" to JsonPrimitive("z".repeat(44)), "idempotencyKey" to JsonPrimitive("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")))
        for (time in listOf("2035-02-30T00:00:02.123456Z", "2035-01-01T00:00:02.123Z", "2035-01-01T00:00:02.1234567Z", "2035-01-01T00:00:02.123456+00:00")) rejects { parse(changed(fixture(), "settlement.settledAt", JsonPrimitive(time))) }
        rejects { parse(JsonObject(fixture() + ("privateSnapshot" to JsonObject(emptyMap())))) }
        rejects { parse(JsonObject(fixture() - "claimId")) }
        rejects { p(JsonObject(fixture().getValue("preparation").jsonObject - "submissionAuthorized")) }
    }
    @Test fun `arrays bounded before traversal and decoded lists are deeply owned`() {
        for (path in listOf("wires", "preparation.transactions", "settlement.receipt.transactions")) rejects { parse(changed(fixture(), path, JsonArray(List(3) { JsonNull }))) }
        rejects { parse(changed(fixture(), "preparation.transactions.0.newAccounts", JsonArray(List(11) { JsonNull }))) }
        rejects { parse(changed(fixture(), "wires.0.signedTransactionHex", JsonPrimitive("ab".repeat(1233)))) }
        val raw = fixture().toMutableMap(); val v = parse(JsonObject(raw)); raw["wallet"] = JsonPrimitive("bad")
        assertEquals(p().wallet, v.wallet)
        rejects { (v.wires as MutableList).clear() }; rejects { (v.preparation!!.transactions as MutableList).clear() }
        rejects { (v.preparation!!.transactions[0].newAccounts as MutableList).clear() }
        rejects { (v.preparation!!.setup.accrualDays as MutableList).clear() }; rejects { (v.settlement!!.receipt.transactions as MutableList).clear() }
    }
    @Test fun `submit accepts only a bounded canonical base64 packet and original key`() {
        val f = parse(); val hex = f.wires.single().signedTransactionHex
        val wire = Base64.getEncoder().encodeToString(hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        val request = buildJsonObject { put("idempotencyKey", f.idempotencyKey); put("signedTransaction", wire) }
        assertEquals(wire, MiningTaxClaimsSubmitRequest.from(request).signedTransaction)
        for (value in listOf(wire + "=", wire + "\n", "A".repeat(1648), "AQ==", "A".repeat(87) + "B=")) rejects { MiningTaxClaimsSubmitRequest.from(changed(request, "signedTransaction", JsonPrimitive(value))) }
        for (extra in listOf("wallet", "ordinal", "relayAuthorized")) rejects { MiningTaxClaimsSubmitRequest.from(JsonObject(request + (extra to JsonPrimitive(true)))) }
    }
    @Test fun `prepare request uses supplied current spot bounds while history is independent`() {
        val request = buildJsonObject { put("idempotencyKey", p().idempotencyKey); put("round", p().round); put("spot", 0); put("caps", fixture().getValue("preparation").jsonObject.getValue("caps")) }
        assertEquals(0L, MiningTaxClaimsPrepareRequest.from(request, totalSpots = 3).spot)
        rejects { MiningTaxClaimsPrepareRequest.from(changed(request, "spot", JsonPrimitive(3)), totalSpots = 3) }
        rejects { MiningTaxClaimsPrepareRequest.from(request, totalSpots = 0) }
        val envelope = buildJsonObject { put("wallet", p().wallet); put("idempotencyKey", p().idempotencyKey); put("status", "prepared"); put("preparation", fixture().getValue("preparation")); put("serverNow", fixture().getValue("serverNow")) }
        assertEquals(p(), MiningTaxClaimsPreparationEnvelope.from(envelope).preparation)
        rejects { MiningTaxClaimsPreparationEnvelope.from(changed(envelope, "status", JsonPrimitive("unknown"))) }
    }
}
