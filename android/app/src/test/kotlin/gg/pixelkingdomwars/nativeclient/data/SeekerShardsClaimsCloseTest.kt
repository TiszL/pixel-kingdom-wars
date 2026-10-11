package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.seeker.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.phasee.seekerShardsCanReview
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit): an attempted Seeker SHARDS claim the server has no receipt for used to hold
 *  REVIEW CLAIM shut forever (confirm and review refuse once attempted). CLOSE re-reads the by-key receipt and archives
 *  it as "server-unknown" only when that read answers no receipt; a late receipt still merges into history. */
class SeekerShardsClaimsCloseTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder)
        val fixture = Json.parseToJsonElement(javaClass.getResource("/seeker-shards-claims.json")!!.readText()).jsonObject
        val policy = SeekerShardsClaimsPolicy.from(fixture.getValue("policy").jsonObject)
        val canonical = SeekerShardsClaimEnvelope.from(fixture.getValue("envelope").jsonObject, policy).receipt!!
        val store = SeekerShardsClaimStore(MemoryStore(), StarterIdentity(session.origin, "devnet", WALLET), policy)
        var posts = 0; var byKeyReads = 0; var accepted = false
        val row = SeekerShardsEntitlementView.from(fixture.getValue("entitlements").jsonObject, policy).rows.single()
        val view = SeekerShardsEntitlementView.from(fixture.getValue("entitlements").jsonObject, policy).copy(wallet = WALLET, claimsEnabled = true)
        fun receipt() = canonical.copy(idempotencyKey = id(2), id = id(2), baseId = BASE_ID, wallet = WALLET)
        val port = object : SeekerShardsClaimPort {
            override suspend fun get(path: String, query: Map<String, String>, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
                guard(); if (path == "/seeker/shards/entitlements") return Json.encodeToJsonElement(view).jsonObject.also(retain)
                assertEquals("/seeker/shards/claims/by-key/${id(2)}", path); byKeyReads++
                return Json.encodeToJsonElement(SeekerShardsClaimEnvelope(WALLET, if (accepted) receipt() else null)).jsonObject.also(retain)
            }
            override suspend fun post(body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit): JsonObject {
                guard(); posts++; throw java.io.IOException("connection lost after the claim was sent")
            }
        }
        val repository = SeekerShardsClaimsRepository(session, holder, port, store, { BASE_ID }, { 0L },
            { BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1))) }, {},
            { guard -> guard() }, { true }, { id(2) })
        suspend fun sentAndLost() {
            repository.refresh(); repository.reviewClaim(row)
            assertTrue(runCatching { repository.confirm(repository.state.value.review!!) }.isFailure)
            val op = store.read().operation!!; assertNotNull(op.attemptRevision); assertNull(op.receipt); assertEquals(1, posts)
        }
    }

    @Test fun `an attempted SHARDS claim the server does not know cannot block REVIEW CLAIM forever`() = runBlocking {
        val f = Fixture(); f.sentAndLost(); f.repository.refresh()
        assertFalse(seekerShardsCanReview(f.repository.state.value, BASE_ID, true))
        assertTrue("the attempted request cannot be reviewed or sent again", runCatching { f.repository.reviewSaved() }.isFailure)
        val reads = f.byKeyReads
        f.repository.archiveUnknown(f.store.read())
        assertTrue("CLOSE made its own fresh by-key read", f.byKeyReads > reads)
        assertNull(f.store.read().operation); assertEquals("server-unknown", f.store.read().archives.single().reason)
        assertEquals("CLOSE never sends a claim", 1, f.posts)
        f.repository.refresh(); assertTrue(seekerShardsCanReview(f.repository.state.value, BASE_ID, true))
        f.accepted = true; f.repository.checkArchive(id(2))
        assertEquals("a late receipt still lands in the archive", f.receipt(), f.store.read().archives.single().operation.receipt)
    }

    @Test fun `close is refused when the server shows the SHARDS claim receipt`() = runBlocking {
        val f = Fixture(); f.sentAndLost(); f.accepted = true
        f.repository.archiveUnknown(f.store.read())
        assertEquals(f.receipt(), f.store.read().operation!!.receipt); assertTrue(f.store.read().archives.isEmpty()); assertEquals(1, f.posts)
        assertTrue(runCatching { f.repository.archiveUnknown(f.store.read()) }.isFailure)
    }
}
