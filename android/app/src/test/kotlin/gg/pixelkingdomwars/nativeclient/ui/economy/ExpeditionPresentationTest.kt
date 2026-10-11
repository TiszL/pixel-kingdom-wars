package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.data.StarterExpeditionState
import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentFittingSnapshot
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentSecondaryOutput
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import gg.pixelkingdomwars.nativeclient.ui.phasee.paidStarterControls
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Presentation must not infer delivery, recalculate old cargo or redirect original recovery. */
class ExpeditionPresentationTest {
    private val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/paid-starter-expedition.json")).readText()).jsonObject
    private val proof = Json.decodeFromJsonElement<StarterExpeditionProof>(raw.getValue("envelope"))
    private val receipt = requireNotNull(proof.receipt)
    private val installed = StarterFleetInstallation(receipt.installationId, receipt.request.baseId, receipt.termId, "starter", receipt.termId, receipt.departedAt, receipt.departedAt)
    private val command = StarterExpeditionCommand(receipt.request, receipt.route.copy(access = StarterExpeditionAccess("paid_realm", 1)), installed)
    private val identity = StarterIdentity("https://presentation.test", "devnet", receipt.wallet)
    private val draft = StarterExpeditionOperation(command, null, null, null)

    @Test fun `canonical realm names label current and historical routes without changing their identifiers`() {
        assertEquals("Solana Reach", starterLabel("seeker-reach"))
        assertEquals("Realm expedition · Solana Reach", starterLabel("paid_seeker_reach"))
        assertEquals("Common Solana Reach", starterLabel("common_seeker_reach"))
        assertEquals("Realm expedition · Frostveil", starterLabel("paid_frostveil"))
        assertEquals("Heartwood Logs", starterLabel("heartwood_logs"))
        assertEquals(receipt.request.routeId, command.route.routeId)
    }
    @Test fun `an unsent draft and an unknown attempted departure are neither departed nor returned`() {
        assertEquals("SAVED DRAFT", expeditionSavedPill(draft).label)
        val unknown = draft.copy(attemptRevision = 1)
        assertEquals("CHECK OUTCOME", expeditionSavedPill(unknown).label)
        assertEquals(PaymentTone.TROUBLE, expeditionSavedPill(unknown).tone)
    }
    @Test fun `accepted departure remains departed after its due time without a return receipt`() {
        val accepted = proof.copy(serverNow = receipt.returnsAt, returned = null)
        accepted.validate(identity, command)
        val pill = expeditionSavedPill(draft.copy(attemptRevision = 1, proof = accepted))
        assertEquals("DEPARTED", pill.label)
        assertNotEquals(PaymentTone.DONE, pill.tone)
    }
    @Test fun `only an observed server return displays returned`() {
        val returned = proof.copy(serverNow = receipt.returnsAt, returned = StarterExpeditionReturn("00000000-0000-4000-8000-000000000099", receipt.returnsAt))
        returned.validate(identity, command)
        val pill = expeditionSavedPill(draft.copy(attemptRevision = 1, proof = returned))
        assertEquals("RETURNED", pill.label)
        assertEquals(PaymentTone.DONE, pill.tone)
    }
    @Test fun `late acceptance wins over preserved refusal without erasing its original details`() {
        val declined = draft.copy(attemptRevision = 1, refusal = StarterExpeditionRefusal(503, "EXPEDITION_ACCESS_UNAVAILABLE"))
        assertEquals("DECLINED", expeditionSavedPill(declined).label)
        val accepted = declined.copy(proof = proof.copy(returned = null))
        assertEquals("DEPARTED", expeditionSavedPill(accepted).label)
        assertTrue(expeditionOriginalDetails(accepted).any { it.label == "Original refusal" && it.value.contains("EXPEDITION_ACCESS_UNAVAILABLE") })
    }
    @Test fun `historical gross pool and net remain exact even above floating point precision`() {
        val old = command.route.copy(grossQuantity = "9007199254740997", netQuantity = "9007199254740991", islandPoolQuantity = "6")
        assertEquals(listOf(ExpeditionCargo(old.resourceId, "9007199254740997", "6", "9007199254740991")), expeditionCargo(old))
        assertEquals("9,007,199,254,740,991", fmtN(expeditionCargo(old).single().net))
    }
    @Test fun `Lens displays both original cargo legs without recomputing their split`() {
        val lens = command.route.copy(grossQuantity = "23", netQuantity = "19", islandPoolQuantity = "4",
            secondaryOutput = EquipmentSecondaryOutput("heartwood_logs", "7", "6", "1"),
            fitting = EquipmentFittingSnapshot("survey_lens", 1, command.route.durationSec, "30", "25", "5", "heartwood_logs"))
        assertEquals(listOf(ExpeditionCargo(command.route.resourceId, "23", "4", "19"), ExpeditionCargo("heartwood_logs", "7", "1", "6")), expeditionCargo(lens))
        assertEquals(command.route.durationSec, lens.durationSec)
    }
    @Test fun `review details keep the saved producing kingdom and installed fleet rather than a current selection`() {
        val details = expeditionCommandDetails(command)
        assertEquals(command.request.baseId, details.single { it.label == "Producing kingdom" }.value)
        assertEquals(installed.installationId, details.single { it.label == "Installed fleet" }.value)
        assertEquals(command.key, details.single { it.label == "Original request" }.value)
        assertEquals(command.route.durationSec.toString(), details.single { it.label == "Duration (seconds)" }.value)
    }
    @Test fun `unknown paid presentation leaves only receipt recovery reachable across pause and base change`() {
        val unknown = draft.copy(attemptRevision = 1)
        val state = StarterExpeditionState(StarterExpeditionJournal(1, identity, 1, unknown, emptyList()))
        for ((base, allowed) in listOf(command.request.baseId to true, command.request.baseId to false, null to true)) {
            val controls = paidStarterControls(state, base, allowed)
            // Rewritten 2026-10-06 (dead-end audit): beside receipt recovery, only CLOSE (the archive action, which closes
            // after a fresh `unknown` receipt) is reachable, so an unknown paid attempt cannot block departures forever.
            assertTrue(controls.check && controls.archive)
            assertFalse(controls.confirm || controls.reviewSaved || controls.finish)
            assertEquals("CHECK OUTCOME", expeditionSavedPill(unknown).label)
        }
    }
}
