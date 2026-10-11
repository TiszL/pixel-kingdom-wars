package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.freebase.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.phasee.freeBasePurchaseCanReview
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit): a saved second-kingdom request the server has no receipt for must not
 *  block REVIEW KINGDOM PURCHASE forever once its reviewed terms can no longer be admitted. CLOSE re-reads the
 *  by-key receipt and only an answer of "no receipt" for exactly that key clears it; a receipt always wins. */
class FreeBasePurchaseCloseTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val store = FreeBasePurchaseStore(MemoryStore(), StarterIdentity(session.origin, "devnet", WALLET))
        var posts = 0; var byKeyReads = 0; var accepted = false
        val terms = FreeBasePurchaseTerms(1, "98765", 6, 2, 3, 2, 5)
        var view = FreeBasePurchaseView(1, WALLET, true, BASE_ID, terms, FreeBasePurchaseAdmission(true, "ready"), null)
        fun receipt() = FreeBasePurchaseReceipt(1, WALLET, id(2), BASE_ID, id(3), 2, terms.costShards, id(4), FreeBasePurchaseDevelopment(id(5), 6, id(6), 2, id(7), 3), "2026-09-25T00:00:00.000Z")
        val api = object : ApiClient by FakeApiClient() {
            override suspend fun getFreeBasePurchase(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/bases/free-purchases") return Json.encodeToJsonElement(view).jsonObject
                assertEquals("/bases/free-purchases/by-key/${id(2)}", path); byKeyReads++
                return Json.encodeToJsonElement(FreeBasePurchaseEnvelope(if (accepted) receipt() else null)).jsonObject.also { evidence!!(it) }
            }
            override suspend fun postFreeBasePurchase(body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject {
                guard(); posts++; throw java.io.IOException("connection lost after the purchase was sent")
            }
        }
        val repository = FreeBasePurchaseRepository(session, holder, api, store, { BASE_ID }, { 0L },
            { BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1))) }, {}, { true }, { id(2) })
        /** Reviewed and sent once; the reply was lost, so the saved request is attempted with no receipt. */
        suspend fun sentAndLost() {
            repository.reviewPurchase(); val review = repository.state.value.review!!
            assertTrue(runCatching { repository.confirm(review) }.isFailure)
            assertNotNull(store.read().operation!!.attemptRevision); assertNull(store.read().operation!!.receipt); assertEquals(1, posts)
        }
    }

    @Test fun `a saved purchase the server does not know cannot block REVIEW KINGDOM PURCHASE forever`() = runBlocking {
        val f = Fixture(); f.sentAndLost()
        f.view = f.view.copy(terms = f.terms.copy(costShards = "99999"))
        f.repository.refresh()
        assertFalse("the saved request pins old terms, so REVIEW is shut", freeBasePurchaseCanReview(f.repository.state.value, BASE_ID, true))
        assertTrue("retrying the same request is impossible under the new terms", runCatching { f.repository.reviewPurchase() }.isFailure)
        val reads = f.byKeyReads
        f.repository.close(f.store.read())
        assertTrue("CLOSE made its own fresh by-key read", f.byKeyReads > reads)
        assertNull(f.store.read().operation); assertEquals("CLOSE never sends a purchase", 1, f.posts)
        f.repository.refresh()
        assertTrue(freeBasePurchaseCanReview(f.repository.state.value, BASE_ID, true))
    }

    @Test fun `close is refused when the server shows the purchase receipt`() = runBlocking {
        val f = Fixture(); f.sentAndLost(); f.accepted = true
        f.repository.close(f.store.read())
        assertEquals(f.receipt(), f.store.read().operation!!.receipt); assertEquals(1, f.posts)
        assertTrue(runCatching { f.repository.close(f.store.read()) }.isFailure)
    }
}
