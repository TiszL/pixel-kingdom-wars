package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.seeker.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SeekerShardsClaimsRepositoryTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder)
        val fixture = Json.parseToJsonElement(javaClass.getResource("/seeker-shards-claims.json")!!.readText()).jsonObject
        val policy = SeekerShardsClaimsPolicy.from(fixture.getValue("policy").jsonObject)
        val canonical = SeekerShardsClaimEnvelope.from(fixture.getValue("envelope").jsonObject, policy).receipt!!
        val store = SeekerShardsClaimStore(MemoryStore(), StarterIdentity(session.origin, "devnet", WALLET), policy)
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var posts = 0; var accepted = false
        var hydrateFails = false; var hydrations = 0; var owned = true; var directoryAvailable = true; var afterOwned: () -> Unit = {}
        val row = SeekerShardsEntitlementView.from(fixture.getValue("entitlements").jsonObject, policy).rows.single()
        var view = SeekerShardsEntitlementView.from(fixture.getValue("entitlements").jsonObject, policy).copy(wallet = WALLET, claimsEnabled = true)
        fun receipt() = canonical.copy(idempotencyKey = id(2), id = id(2), baseId = BASE_ID, wallet = WALLET)
        val port = object : SeekerShardsClaimPort {
            override suspend fun get(path: String, query: Map<String, String>, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
                guard(); return if (path == "/seeker/shards/entitlements") Json.encodeToJsonElement(view).jsonObject.also(retain)
                else Json.encodeToJsonElement(SeekerShardsClaimEnvelope(WALLET, if (accepted) receipt() else null)).jsonObject.also(retain)
            }
            override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
                guard(); assertNotNull(store.read().operation!!.attemptRevision); posts++; accepted = true
                return Json.encodeToJsonElement(SeekerShardsClaimEnvelope(WALLET, receipt())).jsonObject.also { retain(it); afterOwned() }
            }
        }
        fun repository() = SeekerShardsClaimsRepository(session, holder, port, store, { selected }, { generation },
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
        assertEquals(SeekerShardsHydration.ORIGINAL_BASE_UNAVAILABLE, restarted.state.value.hydration)
    }
    @Test fun `unavailable ownership cannot archive a receipt as transferred`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.repository.reviewClaim(f.row); f.repository.confirm(f.repository.state.value.review!!)
        f.directoryAvailable = false; assertTrue(runCatching { f.repository.finish() }.isFailure)
        assertNotNull(f.store.read().operation?.receipt); assertNull(f.repository.state.value.hydration)
    }
    @Test fun `changed original term hash and zero due refuse a fresh claim`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.view = f.view.copy(rows = listOf(f.row.copy(termHash = "b".repeat(64))))
        assertTrue(runCatching { f.repository.reviewClaim(f.row) }.isFailure); assertNull(f.store.read().operation)
        f.view = f.view.copy(rows = listOf(f.row.copy(claimedTotal = f.row.cumulativeTotal, dueQuantity = "0")))
        assertTrue(runCatching { f.repository.reviewClaim(f.view.rows.single()) }.isFailure); assertEquals(0, f.posts)
    }
    @Test fun `failed hydration preserves acceptance until current stock is refreshed`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.repository.reviewClaim(f.row); f.repository.confirm(f.repository.state.value.review!!)
        f.hydrateFails = true; assertTrue(runCatching { f.repository.finish() }.isFailure); assertNotNull(f.store.read().operation)
        f.hydrateFails = false; f.repository.finish(); assertEquals(1, f.hydrations); assertEquals(1, f.store.read().archives.size)
    }
}
