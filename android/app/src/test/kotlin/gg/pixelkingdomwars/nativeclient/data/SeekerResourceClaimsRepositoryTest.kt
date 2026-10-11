package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.seekerresources.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerResourceClaimsRepositoryTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder)
        val store = SeekerResourceClaimStore(MemoryStore(), StarterIdentity(session.origin, "devnet", WALLET))
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var posts = 0; var accepted = false
        var hydrateFails = false; var hydrations = 0; var owned = true; var directoryAvailable = true; var afterOwned: () -> Unit = {}
        val row = SeekerResourceEntitlement(id(1), "a".repeat(64), "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z", 0, "rough_prism", 3, "32", "10", "0", "10")
        var view = SeekerResourceEntitlementView(1, WALLET, true, false, "available", null, null, null, listOf(row))
        fun receipt() = SeekerResourceClaimReceipt(id(2), BASE_ID, row.termId, row.resourceId, row.spotId, id(2), WALLET, row.termHash, 3, "32", "0", "10", "10", "7", "17", "2026-09-09T00:00:00.000Z", false)
        val api = object : ApiClient by FakeApiClient() {
            override suspend fun getSeekerResourceClaim(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard(); return if (path == "/seeker/resource-claims") Json.encodeToJsonElement(view).jsonObject
                else Json.encodeToJsonElement(SeekerResourceClaimEnvelope(WALLET, if (accepted) receipt() else null)).jsonObject.also { evidence!!(it) }
            }
            override suspend fun postSeekerResourceClaim(body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject {
                guard(); assertNotNull(store.read().operation!!.attemptRevision); posts++; accepted = true
                return Json.encodeToJsonElement(SeekerResourceClaimEnvelope(WALLET, receipt())).jsonObject.also { evidence(it); afterOwned() }
            }
        }
        fun repository() = SeekerResourceClaimsRepository(session, holder, api, store, { selected }, { generation },
            { BaseDirectory(directoryAvailable, capabilities = BaseCapabilities(true, true), bases = if (owned) listOf(BaseSummary(BASE_ID, "active", slot = 1)) else emptyList()) }, {},
            { guard -> guard(); check(!hydrateFails); hydrations++; guard() }, { allowed }, { id(2) })
        val repository = repository()
    }
    @Test fun `discovery and paused original rights do not require a selected kingdom`() = runBlocking {
        val f = Fixture(); f.selected = null; f.allowed = false; f.view = f.view.copy(claimsEnabled = false)
        f.repository.refresh(); assertEquals(listOf(f.row), f.repository.state.value.view!!.rows); assertEquals(0, f.posts)
        assertTrue(runCatching { f.repository.reviewClaim(f.row) }.isFailure)
    }
    @Test fun `destination ABA or admission pause invalidates consent before submission`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.repository.reviewClaim(f.row); val review = f.repository.state.value.review!!
        f.generation += 2; assertTrue(runCatching { f.repository.confirm(review) }.isFailure); assertEquals(0, f.posts)
        f.repository.dismiss(); f.allowed = false; assertTrue(runCatching { f.repository.reviewSaved() }.isFailure); assertEquals(0, f.posts)
    }
    @Test fun `late accepted reply remains recoverable after view retirement and transfer`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.repository.reviewClaim(f.row); val review = f.repository.state.value.review!!
        f.afterOwned = { f.repository.dismiss() }; assertTrue(runCatching { f.repository.confirm(review) }.isFailure)
        assertEquals(f.receipt(), f.store.read().operation!!.receipt)
        f.selected = null; f.owned = false; f.allowed = false
        val restarted = f.repository(); restarted.check(); restarted.finish()
        assertEquals(1, f.posts); assertNull(f.store.read().operation); assertEquals(0, f.hydrations)
        assertEquals(SeekerResourceHydration.ORIGINAL_BASE_UNAVAILABLE, restarted.state.value.hydration)
    }
    @Test fun `unavailable ownership cannot archive a receipt as transferred`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.repository.reviewClaim(f.row); f.repository.confirm(f.repository.state.value.review!!)
        f.directoryAvailable = false; assertTrue(runCatching { f.repository.finish() }.isFailure)
        assertNotNull(f.store.read().operation?.receipt); assertNull(f.repository.state.value.hydration)
    }
    @Test fun `failed hydration preserves acceptance until current stock is refreshed`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.repository.reviewClaim(f.row); f.repository.confirm(f.repository.state.value.review!!)
        f.hydrateFails = true; assertTrue(runCatching { f.repository.finish() }.isFailure); assertNotNull(f.store.read().operation)
        f.hydrateFails = false; f.repository.finish(); assertEquals(1, f.hydrations); assertEquals(1, f.store.read().archives.size)
    }
}
