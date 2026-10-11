package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.wallet.SkrIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class SkrFaucetDiscoveryCursorTest {
    private fun vector(name: String): JsonObject {
        val input = javaClass.getResourceAsStream("/skr-faucet-discovery-vectors.json")
        assertNotNull("MISSING: actual authenticated P5 discovery route vectors", input)
        return Json.parseToJsonElement(input!!.bufferedReader().use { it.readText() }).jsonObject.getValue(name).jsonObject
    }
    @Test fun `cursor query is exact and a new durable intent cannot inherit another intent's page`() = runBlocking {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val journal = SkrFaucetJournal(MemoryStore(), session.wallet, session.origin, "devnet")
        val base = "11111111-1111-4111-8111-111111111111"
        val target = SkrFaucetGrant.from(vector("pendingPage").getValue("items").jsonArray.single().jsonObject)
        val day = Instant.parse(target.requestedAt).atOffset(ZoneOffset.UTC).toLocalDate().toString()
        val repo = SkrFaucetRepository(session, holder, api, journal, { SkrIdentity(target.mint, target.decimals) },
            { SkrFaucetBounds(5000, "1000", 20) }, { base }, { _, _, _ -> error("No prompt") }, {})
        api.onGet("/devnet-skr-faucet/status") { vector("nextDayStatus") }
        api.onGet("/devnet-skr-faucet/grants") { vector("newerPage") }
        val saved = journal.beginIfEmpty(base, day); repo.refresh()
        val cursor = requireNotNull(repo.state.value.discoveryNextCursor)
        api.onGet("/devnet-skr-faucet/grants") { vector("emptyPage") }
        repo.discoverOlder()
        assertEquals(mapOf("after" to cursor), api.gets.last().second)
        // review 8938311c M3: complete next-day no-match releases the unsigned intent.
        assertNull(journal.read()); val next = journal.beginIfEmpty(base, day)
        assertNotEquals(saved.intentId, next.intentId)
        repo.refresh()
        assertTrue(api.gets.last().second.isEmpty()); assertTrue(api.posts.isEmpty())
    }
}
