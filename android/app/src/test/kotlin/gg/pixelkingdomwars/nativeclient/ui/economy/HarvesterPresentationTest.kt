package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server observations exercise presentation; they do not establish earning authority. */
class HarvesterPresentationTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val now = "2026-09-22T12:00:00.000Z"
    private fun after(seconds: Long) = DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.parse(now).plusSeconds(seconds))
    private val policy = HarvesterPolicy(1, 1, "99", "7", 17, 255, 1, 100, 30)
    private val facility = HarvesterFacility(BASE_ID, id(3), id(4), after(-1))
    private val command = HarvesterCommand(HarvesterRequest(id(2), BASE_ID, facility.harvesterId, null, 1), facility, "crownlands", policy, null)
    private val draft = HarvesterOperation(command, null, null, null)
    private val identity = HarvesterIdentity("https://presentation.test", "devnet", WALLET)
    private val source = HarvesterSource(command.key, BASE_ID, facility.harvesterId, 1, "crownlands", "crown_iron_ore", now, after(policy.maxLeaseSec),
        facility.completedBuildJobId, facility.harvesterCompletedAt, HarvesterTerm(id(6), "a".repeat(64), after(-60), after(3600)), policy)
    private fun event(n: Int) = HarvesterEvent(command.key, n, n.toString(), source.resourceId, 1, after(17L * n), after(17L * n + 1),
        "2026-09-22T00:00:00.000Z", "7", "5", "2", 1, 100, 30, ((n - 1) * 10).toString(), (n * 10).toString())
    private val settlement = HarvesterSettlement(listOf(event(1), event(2)), null, null)
    private fun proof(value: HarvesterSettlement = settlement) = HarvesterProof(WALLET, command.key, after(500), "accepted", HarvesterReceipt(WALLET, command.request, source), value)
    private val view = HarvesterView(WALLET, BASE_ID, now, HarvesterFeatures(HarvesterFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), listOf(facility), null, null, policy,
        listOf(OrdinaryRawStock("crown_iron_ore", "999", "1", "1000")))

    @Test fun `draft and lost reply never imply an accepted earning source`() {
        assertEquals("SAVED DRAFT", harvesterSavedPill(draft).label)
        assertEquals("CHECK OUTCOME", harvesterSavedPill(draft.copy(attemptRevision = 1)).label)
        assertEquals(PaymentTone.TROUBLE, harvesterSavedPill(draft.copy(attemptRevision = 1)).tone)
    }
    @Test fun `an expired accepted source does not become closed without server closure`() {
        val accepted = proof(); accepted.validate(identity, command)
        assertEquals("ACCEPTED", harvesterSavedPill(draft.copy(attemptRevision = 1, proof = accepted)).label)
        assertNotEquals(PaymentTone.CLOSED, harvesterSavedPill(draft.copy(proof = accepted)).tone)
    }
    @Test fun `only observed closure closes presentation and late acceptance outranks refusal`() {
        val closed = proof(settlement.copy(closure = HarvesterClosure(command.key, "facility_removed", after(35), 2)))
        closed.validate(identity, command)
        val declined = draft.copy(attemptRevision = 1, refusal = HarvesterRefusal(503, "HARVESTERS_DISABLED"))
        assertEquals("DECLINED", harvesterSavedPill(declined).label)
        val recovered = declined.copy(proof = closed)
        assertEquals("CLOSED", harvesterSavedPill(recovered).label)
        assertTrue(harvesterOriginalDetails(recovered).any { it.label == "Original refusal" && it.value.contains("HARVESTERS_DISABLED") })
    }
    @Test fun `observed delivery excludes elapsed unobserved periods and current kingdom stock`() {
        proof().validate(identity, command)
        assertEquals(HarvesterObservedAmounts("14", "10", "4"), harvesterObservedAmounts(settlement))
        assertNotEquals(view.rawStock.single().available, harvesterObservedAmounts(settlement).delivered)
        assertEquals(HarvesterObservedAmounts("0", "0", "0"), harvesterObservedAmounts(HarvesterSettlement(emptyList(), null, null)))
    }
    @Test fun `historical display retains integer precision and original producing identifiers`() {
        val large = settlement.copy(events = listOf(event(1).copy(grossQuantity = "9007199254740997", netQuantity = "9007199254740991", islandPoolQuantity = "6")))
        assertEquals(HarvesterObservedAmounts("9007199254740997", "9007199254740991", "6"), harvesterObservedAmounts(large))
        val details = harvesterCommandDetails(command)
        assertEquals(BASE_ID, details.single { it.label == "Producing kingdom" }.value)
        assertEquals(facility.harvesterId, details.single { it.label == "Harvester" }.value)
        assertEquals(command.key, details.single { it.label == "Original request" }.value)
    }
    @Test fun `new selection stays disabled during pause busy saved work or missing home authority`() {
        assertTrue(harvesterSelectionReady(view, null, true, false))
        assertFalse(harvesterSelectionReady(view, draft, true, false))
        assertFalse(harvesterSelectionReady(view, null, false, false))
        assertFalse(harvesterSelectionReady(view, null, true, true))
        assertFalse(harvesterSelectionReady(view.copy(acceptingSelections = false), null, true, false))
        assertFalse(harvesterSelectionReady(view.copy(home = null), null, true, false))
    }
}
