package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.time.Instant
import java.time.ZoneOffset

class SkrFaucetDiscoveryTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-discovery-vectors.json")
        assertNotNull("MISSING: actual P5 authenticated discovery route vectors", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient(); val disk = MemoryStore()
        val journal = SkrFaucetJournal(disk, session.wallet, session.origin, "devnet")
        val base = "11111111-1111-4111-8111-111111111111"
        val target = SkrFaucetGrant.from(vector("pendingPage").getValue("items").jsonArray.single().jsonObject)
        val day = Instant.parse(target.requestedAt).atOffset(ZoneOffset.UTC).toLocalDate().toString()
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(target.mint, target.decimals) },
            { SkrFaucetBounds(5000, "1000", 20) }, { base }, { _, _, _ -> error("Discovery never signs") }, {})
        fun nextDay() { api.onGet("/devnet-skr-faucet/status") { vector("nextDayStatus") } }
    }
    @Test fun `lost claim acknowledgment retains server day before POST and discovers its owned prior day grant without replay`() = runBlocking {
        val f = Fixture()
        f.api.onGet("/devnet-skr-faucet/status") { vector("beforeClaimStatus") }
        f.api.onPost("/devnet-skr-faucet/claim") {
            assertEquals(f.day, f.journal.read()!!.claimDay)
            throw IOException("lost acknowledgement")
        }
        f.repo.claim(); val intent = requireNotNull(f.journal.read()); assertNull(intent.grant)
        f.nextDay(); f.api.onGet("/devnet-skr-faucet/grants") { vector("pendingPage") }
        f.repo.refresh()
        assertEquals(intent.intentId, f.journal.read()!!.intentId); assertEquals(f.target.id, f.journal.read()!!.grant!!.id)
        assertEquals(1, f.api.posts.size); assertFalse(f.repo.state.value.uncertain)
    }
    // Rewritten 2026-10-06 (dead-end audit): owner rule, no saved request may block play forever. The legacy no-day
    // intent used to be retained forever even after a complete empty scan; that same complete zero-pending proof now
    // releases it too (SkrFaucetNoDayReleaseTest pins that any pending grant still keeps it).
    @Test fun `complete next-day empty discovery releases unsigned intent including legacy no-day evidence`() = runBlocking {
        for (legacy in listOf(false, true)) {
            val f = Fixture(); f.nextDay()
            f.journal.beginIfEmpty(f.base, if (legacy) null else f.day)
            f.api.onGet("/devnet-skr-faucet/grants") { vector("emptyPage") }
            f.repo.refresh()
            // review 8938311c M3 supersedes indefinite retention only after complete past-day absence.
            assertNull(f.journal.read()); assertFalse(f.repo.state.value.uncertain); assertFalse(f.repo.state.value.canClaim)
            assertTrue(f.api.posts.isEmpty())
        }
    }
    @Test fun `unknown discovery phase cannot attach a candidate to durable money evidence`() = runBlocking {
        val f = Fixture(); f.nextDay(); f.journal.beginIfEmpty(f.base, f.day); val before = f.disk.value
        val grant = f.target.raw
        val attempt = grant.getValue("attempt").jsonObject
        val unknown = JsonObject(grant + ("attempt" to JsonObject(attempt + ("phase" to JsonPrimitive("future_phase")))))
        f.api.onGet("/devnet-skr-faucet/grants") {
            buildJsonObject { put("items", buildJsonArray { add(unknown) }); put("nextCursor", JsonNull) }
        }
        f.repo.refresh(); assertEquals(before, f.disk.value); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `older pages are explicit and only owned matching day can attach`() = runBlocking {
        val f = Fixture(); f.nextDay(); f.journal.beginIfEmpty(f.base, f.day)
        var pages = 0
        f.api.onGet("/devnet-skr-faucet/grants") { pages++; vector(if (pages == 1) "newerPage" else "pendingPage") }
        f.repo.refresh(); assertNull(f.journal.read()!!.grant); assertEquals(1, pages)
        assertNotNull(f.repo.state.value.discoveryNextCursor)
        f.repo.discoverOlder()
        assertEquals(2, pages); assertEquals(f.target.id, f.journal.read()!!.grant!!.id); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `version one journal remains readable and new day cannot replace immutable correlation`() {
        val disk = MemoryStore(); val journal = SkrFaucetJournal(disk, WALLET, "https://localhost:18443", "devnet")
        val saved = journal.beginIfEmpty("11111111-1111-4111-8111-111111111111", "2026-10-02")
        assertEquals("2026-10-02", journal.read()!!.claimDay)
        assertThrows(IllegalArgumentException::class.java) { journal.replace(saved, saved.copy(claimDay = "2026-10-03")) }
        val row = Json.parseToJsonElement(disk.value!!).jsonObject
        disk.value = JsonObject((row - "claimDay") + ("version" to JsonPrimitive(1))).toString()
        assertNull(journal.read()!!.claimDay)
    }
}
