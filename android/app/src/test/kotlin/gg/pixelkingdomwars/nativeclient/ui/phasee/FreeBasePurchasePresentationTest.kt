package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.freebase.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import org.junit.Assert.*
import org.junit.Test

class FreeBasePurchasePresentationTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val terms = FreeBasePurchaseTerms(1, "98765", 6, 2, 3, 2, 5)
    private val command = FreeBasePurchaseCommand(FreeBasePurchaseRequest(BASE_ID, id(2)), terms)
    private val draft = FreeBasePurchaseOperation(command, null, null)
    private val receipt = FreeBasePurchaseReceipt(1, WALLET, command.key, BASE_ID, id(3), 2, terms.costShards, id(4),
        FreeBasePurchaseDevelopment(id(5), 6, id(6), 2, id(7), 3), "2026-09-25T00:00:00.000Z")

    @Test fun `saved and attempted purchases remain distinct from an accepted kingdom`() {
        assertEquals("SAVED DRAFT", freeBaseSavedPill(draft).label)
        val unknown = draft.copy(attemptRevision = 1)
        assertEquals("CHECK OUTCOME", freeBaseSavedPill(unknown).label)
        assertNotEquals(PaymentTone.DONE, freeBaseSavedPill(unknown).tone)
        receipt.validate(StarterIdentity("https://presentation.test", "devnet", WALLET), command)
        assertEquals("ACCEPTED", freeBaseSavedPill(unknown.copy(receipt = receipt)).label)
    }
    @Test fun `confirmation displays frozen exact charge including large integer quantities`() {
        assertEquals("SPEND 98,765 SHARDS", freeBaseConfirmation(command))
        val laterOffer = terms.copy(costShards = "9007199254740991")
        assertEquals("SPEND 9,007,199,254,740,991 SHARDS", freeBaseConfirmation(command.copy(terms = laterOffer)))
        assertEquals("98765", draft.command.terms.costShards)
    }
    @Test fun `saved review and receipt retain source versus purchased kingdom independently`() {
        assertEquals(BASE_ID, freeBaseCommandDetails(command).single { it.label == "Source kingdom" }.value)
        val details = freeBaseReceiptDetails(receipt)
        assertEquals(BASE_ID, details.single { it.label == "Source kingdom" }.value)
        assertEquals(id(3), details.single { it.label == "Purchased kingdom" }.value)
        assertEquals(receipt.debitTransactionId, details.single { it.label == "SHARDS debit" }.value)
        assertEquals(command.key, details.single { it.label == "Original request" }.value)
    }
    @Test fun `eligibility copy gives relevant next steps without promising a purchase`() {
        assertTrue(freeBaseAdmissionMessage("development-required").contains("building upgrades"))
        assertTrue(freeBaseAdmissionMessage("insufficient-shards").contains("more SHARDS"))
        assertTrue(freeBaseAdmissionMessage("being-raided").contains("raid"))
        assertTrue(freeBaseAdmissionMessage("source-not-free").contains("free kingdom"))
        assertTrue(freeBaseAdmissionMessage("already-purchased").contains("already been purchased"))
        assertTrue(freeBaseAdmissionMessage("stable-bases-required").contains("unavailable"))
        assertTrue(freeBaseAdmissionMessage("disabled").contains("receipts can still be checked"))
    }
}
