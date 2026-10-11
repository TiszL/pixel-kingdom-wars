package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.freebase.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class FreeBasePurchaseRepositoryTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val store = FreeBasePurchaseStore(MemoryStore(), StarterIdentity(session.origin, "devnet", WALLET))
        var generation = 0L; var allowed = true; var selected: String? = BASE_ID; var posts = 0; var accepted = false
        var afterOwned: () -> Unit = {}
        val terms = FreeBasePurchaseTerms(1, "98765", 6, 2, 3, 2, 5)
        var view = FreeBasePurchaseView(1, WALLET, true, BASE_ID, terms, FreeBasePurchaseAdmission(true, "ready"), null)
        fun receipt() = FreeBasePurchaseReceipt(1, WALLET, id(2), BASE_ID, id(3), 2, terms.costShards, id(4), FreeBasePurchaseDevelopment(id(5), 6, id(6), 2, id(7), 3), "2026-09-25T00:00:00.000Z")
        val api = object : ApiClient by FakeApiClient() {
            override suspend fun getFreeBasePurchase(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                return if (path == "/bases/free-purchases") Json.encodeToJsonElement(view).jsonObject
                else Json.encodeToJsonElement(FreeBasePurchaseEnvelope(if (accepted) receipt() else null)).jsonObject.also { evidence!!(it) }
            }
            override suspend fun postFreeBasePurchase(body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject {
                guard(); assertNotNull(store.read().operation!!.attemptRevision); posts++; accepted = true
                return Json.encodeToJsonElement(receipt()).jsonObject.also { evidence(it); afterOwned() }
            }
        }
        val repository = FreeBasePurchaseRepository(session, holder, api, store, { selected }, { generation },
            { BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1))) }, {}, { allowed }, { id(2) })
    }
    @Test fun `wallet history survives missing selection without a local journal or new admission`() = runBlocking {
        val f = Fixture(); f.selected = null; f.allowed = false
        f.view = f.view.copy(enabled = false, sourceBaseId = null, admission = FreeBasePurchaseAdmission(false, "disabled"), receipt = f.receipt())
        f.repository.refresh()
        assertEquals(f.receipt(), f.repository.state.value.view!!.receipt)
        assertNull(f.store.read().operation); assertNull(f.selected); assertEquals(0, f.posts)
        assertTrue(runCatching { f.repository.reviewPurchase() }.isFailure)
    }
    @Test fun `foreground never purchases and base ABA invalidates reviewed consent`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); assertEquals(0, f.posts); assertNull(f.store.read().operation)
        f.repository.reviewPurchase(); val review = f.repository.state.value.review!!
        f.generation += 2
        assertTrue(runCatching { f.repository.confirm(review) }.isFailure); assertEquals(0, f.posts)
    }
    @Test fun `owned acceptance survives view retirement and paused recovery without selecting the purchased base`() = runBlocking {
        val f = Fixture(); f.repository.reviewPurchase(); val review = f.repository.state.value.review!!
        f.afterOwned = { f.repository.dismiss() }
        assertTrue(runCatching { f.repository.confirm(review) }.isFailure)
        assertEquals(f.receipt(), f.store.read().operation!!.receipt); assertEquals(BASE_ID, f.selected)
        f.allowed = false; f.selected = null; f.repository.check()
        assertEquals(1, f.posts); assertEquals(f.receipt(), f.repository.state.value.journal.operation!!.receipt)
    }
}
