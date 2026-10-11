package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** Owner rule 2026-10-06 (dead-end audit): a saved request may close only after a fresh by-key GET in the same action
 * answered absent for exactly its key, and never against a server record, payment consent or signature. Without this,
 * a listing whose POST never reached the server blocks every new listing from its kingdom once its retry is refused. */
class KeepEquipmentMarketUnknownCloseTest {
    private fun rejects(block: suspend () -> Unit) { assertThrows(Exception::class.java) { runBlocking { block() } } }
    /** A listing whose POST left this device ("post:0") but never reached the server: by-key GET answers the coded 404. */
    private suspend fun lostListing(x: KeepEquipmentMarketFixtures.Fixture, repo: KeepEquipmentMarketRepository): KeepEquipmentMarketRecord {
        repo.reviewListing("route_compass", "1", "1000001"); x.failBeforePost = "listings"; rejects { repo.confirm() }; x.failBeforePost = null
        return x.store.record(x.key).also { assertEquals(listOf("post:0"), it.attempts); assertNull(it.response) }
    }
    /** The same server, except every 404 arrives bare (no server code), as from an unmounted route or a proxy. */
    private fun bare(x: KeepEquipmentMarketFixtures.Fixture) = object : KeepEquipmentMarketPorts by x.ports {
        override val transport = KeepEquipmentMarketTransport(object : KeepEquipmentMarketPort {
            override val identity = x.identity
            override suspend fun request(method: String, path: String, query: Map<String, String>, body: JsonObject?, guard: () -> Unit, retain: suspend (JsonObject) -> Unit): JsonObject =
                try { x.ports.transport.request(method, path, body, guard, query, retain) }
                catch (error: ApiException) { if (error.status == 404) throw ApiException(404, null, "Not Found") else throw error }
        })
    }

    @Test fun `a saved listing the server does not know cannot block new listings forever`() = runBlocking {
        val x = KeepEquipmentMarketFixtures.Fixture(); val repo = x.repo(); val lost = lostListing(x, repo)
        // The dead end: a new listing from the same kingdom is refused, and paused orders refuse the retry.
        x.nextKey = UUID.randomUUID().toString(); rejects { repo.reviewListing("route_compass", "1", "1000001") }
        x.allowed = false; rejects { repo.retry(lost.key) }; assertEquals(1, x.posts.size)
        repo.discard(lost.key)
        val closed = x.store.read().archives.single(); assertEquals(lost.request, closed.request); assertTrue(closed.closedAbsent); assertFalse(closed.discardedUnsent)
        assertTrue(x.store.read().pending.isEmpty()); assertEquals(1, x.posts.size)
        // The door that refused a new listing for this kingdom is open again.
        x.allowed = true; repo.reviewListing("route_compass", "1", "1000001"); assertEquals(x.nextKey, x.store.read().pending.single().key); assertEquals(1, x.posts.size)
    }

    @Test fun `close is refused when the by-key GET shows the listing exists`() = runBlocking {
        val x = KeepEquipmentMarketFixtures.Fixture(); val repo = x.repo()
        repo.reviewListing("route_compass", "1", "1000001"); x.failPost = "listings"; rejects { repo.confirm() }; x.failPost = null
        rejects { repo.discard(x.key) }
        val kept = x.store.read().pending.single(); assertEquals(x.key, kept.key); assertNotNull(kept.response); assertFalse(kept.closedAbsent)
        assertTrue(x.store.read().archives.isEmpty()); assertEquals(1, x.posts.size)
    }

    @Test fun `a bare 404 is not the server answering absent for that key`() = runBlocking {
        val x = KeepEquipmentMarketFixtures.Fixture(); val lost = lostListing(x, x.repo())
        val unmounted = KeepEquipmentMarketRepository(x.store, bare(x)); rejects { unmounted.discard(lost.key) }
        assertEquals(lost, x.store.read().pending.single()); assertTrue(x.store.read().archives.isEmpty()); assertEquals(1, x.posts.size)
    }

    @Test fun `only the unchanged record checked by the closing action can close a sent original`() = runBlocking {
        val x = KeepEquipmentMarketFixtures.Fixture(); val lost = lostListing(x, x.repo())
        rejects { x.store.discard(lost.key) }; rejects { x.store.discard(lost.key, lost.copy(attempts = emptyList())) }
        assertEquals(lost, x.store.read().pending.single())
        x.store.discard(lost.key, lost); assertTrue(x.store.read().archives.single().closedAbsent)
    }

    @Test fun `journals saved before the close flag decode and keep their bytes`() = runBlocking {
        val x = KeepEquipmentMarketFixtures.Fixture(); val repo = x.repo(); val lost = lostListing(x, repo); val before = requireNotNull(x.memory.value)
        assertFalse(before.contains("closedAbsent"))
        assertEquals(lost, KeepEquipmentMarketStore(KeepEquipmentMarketFixtures.Memory().apply { value = before }, x.identity).record(lost.key))
        repo.discard(lost.key); assertTrue(requireNotNull(x.memory.value).contains("\"closedAbsent\":true"))
        assertEquals(x.store.read(), KeepEquipmentMarketStore(KeepEquipmentMarketFixtures.Memory().apply { value = x.memory.value }, x.identity).read())
    }
}
