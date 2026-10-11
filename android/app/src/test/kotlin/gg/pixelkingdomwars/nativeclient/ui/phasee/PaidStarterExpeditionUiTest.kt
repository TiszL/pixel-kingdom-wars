package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.starter.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PaidStarterExpeditionUiTest {
    private val raw = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/paid-starter-expedition.json")).readText()).jsonObject
    private val receipt = Json.decodeFromJsonElement<StarterExpeditionReceipt>(raw.getValue("envelope").jsonObject.getValue("receipt"))
    private val installed = StarterFleetInstallation(receipt.installationId, receipt.request.baseId, receipt.termId, "starter", receipt.termId, receipt.departedAt, receipt.departedAt)
    private val command = StarterExpeditionCommand(receipt.request, receipt.route.copy(access = StarterExpeditionAccess("paid_realm", 1)), installed)
    private val identity = StarterIdentity("https://ui.test", "devnet", receipt.wallet)
    private fun state(operation: StarterExpeditionOperation? = null) = StarterExpeditionState(StarterExpeditionJournal(1, identity, 1, operation, emptyList()))
    private fun operation() = StarterExpeditionOperation(command, null, null, null)
    @Test fun `paid draft review is explicit and unknown attempt exposes GET recovery only`() {
        val draft = state(operation()); val controls = paidStarterControls(draft, receipt.request.baseId, true)
        assertTrue(controls.reviewSaved && controls.check && controls.archive); assertFalse(controls.confirm || controls.finish)
        val attempted = paidStarterControls(state(operation().copy(attemptRevision = 1)), receipt.request.baseId, true)
        // Rewritten 2026-10-06 (dead-end audit): an unknown paid attempt is still never resent, but it now offers CLOSE (the
        // archive action, which closes only after a fresh `unknown` receipt), so it cannot block departures forever.
        assertTrue(attempted.check && attempted.archive); assertFalse(attempted.reviewSaved || attempted.confirm || attempted.finish)
    }
    @Test fun `pause or different base still exposes original checks and safe explicit archive`() {
        for ((base, allowed) in listOf(receipt.request.baseId to false, null to true)) {
            val controls = paidStarterControls(state(operation()), base, allowed)
            assertTrue(controls.check && controls.archive); assertFalse(controls.reviewSaved || controls.confirm)
        }
        assertFalse(paidStarterControls(state(operation()).copy(busy = true), receipt.request.baseId, true).check)
    }
    @Test fun `accepted full history takes precedence over refusal and supports hydration archive`() {
        val proof = Json.decodeFromJsonElement<StarterExpeditionProof>(raw.getValue("envelope"))
        val controls = paidStarterControls(state(operation().copy(attemptRevision = 1, proof = proof, refusal = StarterExpeditionRefusal(503, "EXPEDITION_ACCESS_UNAVAILABLE"))), null, false)
        assertTrue(controls.check && controls.finish); assertFalse(controls.archive || controls.reviewSaved || controls.confirm)
    }
    @Test fun `home original remains recoverable from shared journal without paid review`() {
        val home = operation().copy(command = command.copy(route = command.route.copy(routeId = "coastal_survey", access = null)))
        val controls = paidStarterControls(state(home), receipt.request.baseId, true)
        assertTrue(controls.check && controls.archive); assertFalse(controls.reviewSaved)
    }
    @Test fun `saved originals and damaged storage keep the paid entry reachable when discovery disappears`() {
        assertFalse(paidStarterEntryAvailable(null)); assertTrue(paidStarterEntryAvailable(null, true))
        assertTrue(paidStarterEntryAvailable(state(operation()))); assertTrue(paidStarterEntryAvailable(state().copy(advertised = true)))
        val archive = StarterExpeditionArchive(operation(), "unattempted", null)
        assertTrue(paidStarterEntryAvailable(state().copy(journal = state().journal.copy(archives = listOf(archive)))))
    }
}
