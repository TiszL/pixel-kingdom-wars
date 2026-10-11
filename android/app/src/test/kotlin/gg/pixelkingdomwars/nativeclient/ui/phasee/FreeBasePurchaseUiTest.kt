package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.WALLET
import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.data.FreeBasePurchaseState
import gg.pixelkingdomwars.nativeclient.freebase.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import org.junit.Assert.*
import org.junit.Test

class FreeBasePurchaseUiTest {
    private val terms = FreeBasePurchaseTerms(1, "98765", 6, 2, 3, 2, 5)
    private val journal = FreeBasePurchaseJournal(1, StarterIdentity("https://example.test", "devnet", WALLET), 0, null)
    private val view = FreeBasePurchaseView(1, WALLET, true, BASE_ID, terms, FreeBasePurchaseAdmission(true, "ready"), null)
    @Test fun `entry requires server discovery but saved recovery survives paused and missing source`() {
        assertFalse(freeBasePurchaseEntryAvailable(FreeBasePurchaseState(journal)))
        assertTrue(freeBasePurchaseEntryAvailable(null, true))
        val saved = journal.copy(operation = FreeBasePurchaseOperation(FreeBasePurchaseCommand(FreeBasePurchaseRequest(BASE_ID, "00000000-0000-4000-8000-000000000002"), terms), null, null))
        val paused = FreeBasePurchaseState(saved, view.copy(enabled = false, admission = FreeBasePurchaseAdmission(false, "disabled")))
        assertTrue(freeBasePurchaseEntryAvailable(paused)); assertFalse(freeBasePurchaseCanReview(paused, null, false))
    }
    @Test fun `review requires matching current source server terms and active admission`() {
        val ready = FreeBasePurchaseState(journal, view)
        assertTrue(freeBasePurchaseCanReview(ready, BASE_ID, true))
        assertFalse(freeBasePurchaseCanReview(ready, null, true)); assertFalse(freeBasePurchaseCanReview(ready, BASE_ID, false))
        val command = FreeBasePurchaseCommand(FreeBasePurchaseRequest(BASE_ID, "00000000-0000-4000-8000-000000000002"), terms)
        assertFalse(freeBasePurchaseCanReview(ready.copy(journal = journal.copy(operation = FreeBasePurchaseOperation(command.copy(terms = terms.copy(costShards = "99999")), null, null))), BASE_ID, true))
        assertFalse(freeBasePurchaseCanReview(ready.copy(busy = true), BASE_ID, true))
    }
}
