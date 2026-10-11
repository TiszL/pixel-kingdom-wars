package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Home-scene moves post the web's exact requests (`Overlay` 'base:move' / 'base:moveLine') and settle through the
 * Home read; a refusal is the repository's dismissible notice, never a retried mutation. */
class BuildingMoveTest {
    private class Fixture {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val intents = PendingIntentStore(MemoryStore())
        val repository = LiveBaseRepository(session, holder, api, intents, ReceiptObserver(intents), { BASE_ID })
        init { api.onGet("/base") { baseJson() }; api.onGet("/balances") { balancesJson() }; api.onGet("/tutorial") { tutorialJson() } }
    }
    private val keep = "eee0575f-6df7-4672-91ea-33f497d2e1d6"

    @Test fun `a single move is one PATCH with the tile and the selected base then a Home read`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.api.gets.clear()
        f.api.onPatch("/base/buildings/$keep/move") { buildJsonObject { put("building", buildJsonObject { put("id", keep) }) } }
        f.repository.moveBuilding(keep, 16, 14)
        assertEquals(listOf("/base/buildings/$keep/move" to json("""{"tx":16,"ty":14,"baseId":"$BASE_ID"}""")), f.api.patches)
        assertTrue("No idempotency key, no money op: the web sends a plain PATCH", f.api.posts.isEmpty())
        assertEquals("The move settles through the pinned Home read", listOf("/base", "/balances", "/tutorial"), f.api.gets.map { it.first })
        assertNull(f.repository.state.value.error); assertFalse(f.repository.state.value.loading)
    }
    @Test fun `a wall line is one move-batch POST carrying every wall and the selected base`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.api.gets.clear()
        f.api.onPost("/base/buildings/move-batch") { buildJsonObject { put("moved", 2) } }
        f.repository.moveWalls(listOf(BuildingMove("w1", 10, 15), BuildingMove("w2", 11, 15)))
        assertEquals(listOf("/base/buildings/move-batch" to json("""{"moves":[{"id":"w1","tx":10,"ty":15},{"id":"w2","tx":11,"ty":15}],"baseId":"$BASE_ID"}""")), f.api.posts)
        assertTrue(f.api.patches.isEmpty())
        assertEquals(listOf("/base", "/balances", "/tutorial"), f.api.gets.map { it.first })
        assertTrue(runCatching { f.repository.moveWalls(emptyList()) }.exceptionOrNull() is IllegalArgumentException)
    }
    @Test fun `a refused move surfaces the server's words as the dismissible notice and is never resent`() = runBlocking {
        val f = Fixture(); f.repository.refresh(); f.api.gets.clear()
        f.api.onPatch("/base/buildings/$keep/move") { throw ApiException(409, "TILE_OCCUPIED", "That tile is occupied") }
        val error = runCatching { f.repository.moveBuilding(keep, 16, 14) }.exceptionOrNull()
        assertTrue(error is ApiException)
        assertEquals(1, f.api.patches.size)
        assertEquals("That tile is occupied", f.repository.state.value.error); assertFalse(f.repository.state.value.loading)
        f.repository.clearNotice(); assertNull(f.repository.state.value.error)
    }
}
