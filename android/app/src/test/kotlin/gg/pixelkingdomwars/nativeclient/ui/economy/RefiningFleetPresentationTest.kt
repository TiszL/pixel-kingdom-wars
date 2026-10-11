package gg.pixelkingdomwars.nativeclient.ui.economy

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import org.junit.Assert.*
import org.junit.Test

/** A presentation change cannot promote an attempt or an elapsed due time into delivery. */
class RefiningFleetPresentationTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val started = "2020-01-01T12:00:00.000Z"
    private val due = "2020-01-01T12:00:34.000Z"
    // Supported immutable original, so delivery assertions reach presentation
    // rather than failing early on an unknown recipe version.
    private val recipe = OrdinaryCraftingRecipe(1, "refine_frostglass", 2, 34,
        listOf(OrdinaryCraftingInput("raw", "frost_quartz", "26")), OrdinaryCraftingOutput("frostglass", "6"))
    private val craft = OrdinaryCraftingCommand(OrdinaryCraftingRequest(id(2), BASE_ID, recipe.recipeId, recipe.recipeVersion, 2), recipe)
    private val draft = OrdinaryCraftingOperation(craft, null, null, null)
    private val accepted = OrdinaryCraftingProof(WALLET, craft.key, due, "accepted",
        OrdinaryCraftingReceipt(craft.key, recipe, started, due, WALLET, craft.request), null)
    private val berth = StarterFleetBerth(id(3), id(4), started)
    private val installed = StarterFleetInstallation(id(5), BASE_ID, id(3), "starter", id(4), started, started)
    private val fleet = StarterFleetCommand(StarterFleetRequest(id(6), BASE_ID, berth.berthId), berth, null)
    private val fleetDraft = StarterFleetOperation(fleet, null, null, null)
    private val fleetReceipt = StarterFleetProof(WALLET, fleet.key, started, "accepted", StarterFleetReceipt(WALLET, fleet.request, installed, started))

    @Test fun `a persisted refining draft and lost reply keep outcome checks distinct from delivery`() {
        assertEquals("SAVED DRAFT", ordinaryCraftingSavedPill(draft).label)
        assertEquals("CHECK OUTCOME", ordinaryCraftingSavedPill(draft.copy(attemptRevision = 2)).label)
        assertEquals(PaymentTone.TROUBLE, ordinaryCraftingSavedPill(draft.copy(attemptRevision = 2)).tone)
    }
    @Test fun `an accepted start whose deadline passed still cannot display delivered`() {
        accepted.validate(OrdinaryCraftingIdentity("https://game.example", "devnet", WALLET), craft)
        val pill = ordinaryCraftingSavedPill(draft.copy(attemptRevision = 2, proof = accepted))
        assertEquals("START ACCEPTED", pill.label)
        assertNotEquals(PaymentTone.DONE, pill.tone)
    }
    @Test fun `only positive automatic completion promotes the original refining receipt to delivered`() {
        val completed = accepted.copy(completion = OrdinaryCraftingCompletion(due))
        completed.validate(OrdinaryCraftingIdentity("https://game.example", "devnet", WALLET), craft)
        val pill = ordinaryCraftingSavedPill(draft.copy(attemptRevision = 2, proof = completed))
        assertEquals("DELIVERED", pill.label)
        assertEquals(PaymentTone.DONE, pill.tone)
        assertEquals(recipe, craft.recipe)
    }
    @Test fun `later refining acceptance remains visible alongside preserved archive refusal`() {
        val declined = draft.copy(attemptRevision = 2, refusal = OrdinaryCraftingRefusal(422, "INSUFFICIENT_RAW_STOCK"))
        assertEquals("DECLINED", ordinaryCraftingSavedPill(declined).label)
        assertEquals("START ACCEPTED", ordinaryCraftingSavedPill(declined.copy(proof = accepted)).label)
    }
    @Test fun `a free installation still needs a receipt before it can display confirmed`() {
        assertEquals("SAVED DRAFT", starterFleetSavedPill(fleetDraft).label)
        assertEquals("CHECK OUTCOME", starterFleetSavedPill(fleetDraft.copy(attemptRevision = 2)).label)
        assertEquals("DECLINED", starterFleetSavedPill(fleetDraft.copy(attemptRevision = 2, refusal = StarterFleetRefusal(409, "STARTER_BERTH_UNAVAILABLE"))).label)
    }
    @Test fun `original installation acceptance wins over a preserved earlier refusal`() {
        fleetReceipt.validate(StarterIdentity("https://game.example", "devnet", WALLET), fleet)
        val saved = fleetDraft.copy(attemptRevision = 2, proof = fleetReceipt, refusal = StarterFleetRefusal(409, "STARTER_BERTH_UNAVAILABLE"))
        assertEquals("CONFIRMED", starterFleetSavedPill(saved).label)
        assertEquals(PaymentTone.DONE, starterFleetSavedPill(saved).tone)
        assertEquals(BASE_ID, saved.proof!!.receipt!!.installation.baseId)
    }
    @Test fun `review of an existing fleet never offers to install an additional fleet`() {
        assertEquals("INSTALL FREE FLEET", starterFleetConfirmation(fleet))
        val existing = fleet.copy(installation = installed).also { it.validate() }
        assertEquals("KEEP EXISTING FLEET", starterFleetConfirmation(existing))
        assertEquals(installed, existing.installation)
    }
}
