package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.MiningTaxClaimsPrepareRequest
import gg.pixelkingdomwars.nativeclient.seekerresources.*
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

class IslandSharesPresentationTest {
    private fun row(resource: String = "frost_quartz", due: String = "7") = SeekerResourceEntitlement(
        "00000000-0000-4000-8000-000000000001", "a".repeat(64), "2035-01-01T00:00:00.000Z", "2035-01-02T00:00:00.000Z",
        0, resource, 1, due, due, "0", due)
    private fun page(rows: List<SeekerResourceEntitlement> = listOf(row())) = SeekerResourceEntitlementView(1, "11111111111111111111111111111111",
        true, false, "available", null, null, null, rows)
    private fun op(f: MiningTaxAppFixture) = MiningTaxClaimsOperation(
        MiningTaxClaimsPrepareRequest(f.p.idempotencyKey, f.p.round, f.p.spot, f.p.caps), MiningTaxClaimsSavedTrust.from(f.independentPins),
        f.policy.daySec, true, f.p, emptyList(), emptyList(), false, null, null)

    @Test fun `unavailable share source is never rendered as a zero resource total`() {
        assertNull(islandResourcePageTotals(null))
        assertNull(islandResourcePageTotals(page().copy(status = "unavailable", rows = emptyList())))
        assertEquals(emptyList<Pair<String, String>>(), islandResourcePageTotals(page(emptyList())))
    }
    @Test fun `page subtotal groups like resources without conflating stock or historical claimed amounts`() {
        val first = row().copy(poolTotal = "100", cumulativeTotal = "100", claimedTotal = "93")
        val totals = islandResourcePageTotals(page(listOf(first, row(due = "4").copy(spotId = 1), row("heartwood_logs", "5"))))!!
        assertEquals(listOf("frost_quartz" to "11", "heartwood_logs" to "5"), totals)
        assertEquals("Frost Quartz", islandShareResource("frost_quartz"))
    }
    @Test fun `large page totals keep exact integer precision beyond a single stock bound`() {
        assertEquals(listOf("frost_quartz" to "18,446,744,073,709,551,614"), islandResourcePageTotals(page(listOf(
            row(due = "9223372036854775807"), row(due = "9223372036854775807").copy(spotId = 1)))))
    }
    @Test fun `human date identifies year local time and timezone without changing original timestamp`() {
        val original = "2035-01-01T00:00:00.000Z"
        assertEquals("1 Jan 2035, 04:00 GET", islandShareTime(original, ZoneId.of("Asia/Tbilisi"), Locale.ENGLISH))
        assertEquals("2035-01-01T00:00:00.000Z", original)
        assertEquals("unavailable", islandShareTime("unavailable", ZoneId.of("UTC"), Locale.ENGLISH))
    }
    @Test fun `resource claim unknown outcome stays checking until the original receipt exists`() {
        val r = row()
        val command = SeekerResourceClaimCommand(SeekerResourceClaimRequest("00000000-0000-4000-8000-000000000002",
            "00000000-0000-4000-8000-000000000003", r.termId, r.resourceId, r.spotId), r.termHash, null)
        val saved = SeekerResourceClaimOperation(command, null, null)
        assertEquals("REVIEW", islandResourcePill(saved).label)
        assertEquals("CHECKING", islandResourcePill(saved.copy(attemptRevision = 1)).label)
        val receipt = SeekerResourceClaimReceipt(command.key, command.request.baseId, r.termId, r.resourceId, r.spotId, command.key,
            "11111111111111111111111111111111", r.termHash, 1, "7", "0", "7", "7", "0", "7", r.endsAt, false)
        assertEquals("CLAIMED", islandResourcePill(saved.copy(attemptRevision = 1, receipt = receipt)).label)
    }
    @Test fun `setup and preparation do not display the intended KEEP allocation as already paid`() { MiningTaxAppFixture("split").use { f ->
        val saved = op(f)
        assertNull(islandKeepPaid(saved, 9))
        assertNull(islandKeepPaid(saved.copy(setup = f.setup), 9))
        assertNull(islandKeepPaid(saved.copy(settlement = f.setup), 9))
        assertNull(islandKeepPaid(saved.copy(transactions = listOf(MiningTaxClaimsCustody(0, true, null, true))), 9))
    } }
    @Test fun `only finalized receipt amount supplies the paid headline with explicit fallback for unknown decimals`() { MiningTaxAppFixture().use { f ->
        val saved = op(f).copy(settlement = f.recovery)
        val actual = f.recovery.settlement!!.receipt.paidKeepBaseUnits
        assertEquals("${miningClaimsKeepAmount(actual, 9)} KEEP", islandKeepPaid(saved, 9))
        assertEquals("$actual KEEP base units", islandKeepPaid(saved, null))
        assertNull(islandKeepPaid(saved.copy(settlement = f.recovery.copy(settlement = f.recovery.settlement!!.copy(claimFinalized = false))), 9))
    } }
    @Test fun `proof disclosure preserves exact original request wallet and consent timestamps`() { MiningTaxAppFixture().use { f ->
        val details = islandKeepDetails(op(f)).associate { it.label to it.value }
        assertEquals(f.p.idempotencyKey, details["Request"])
        assertEquals(f.p.wallet, details["Original wallet"])
        assertEquals(f.p.preparedAt, details["Prepared at (UTC)"])
        assertEquals(f.p.expiresAt, details["Consent expires (UTC)"])
    } }
}
