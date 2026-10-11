package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Fantasy world reads for the land gate: the catalogue hash gates the world, a 503 is "not offered", and parcel answers are pinned to the tile asked for
 * AND to the frozen catalogue's realm/allocation for it (web `validateFantasyParcel`). */
class WorldRepositoryTest {
    private val catalogue = json("""{"modules":{"fantasyWorld":{"FANTASY_CATALOG_HASH":"92a3"}}}""")
    /** A 6×4 world: tiles 0..8 frostveil (ordinary), 9..11 seeker-reach (9 genesis, 10..11 seeker), 13..23 crownlands. */
    private val frozen = FantasyCatalog.parse(json("""{"membershipSha256":"c147","regions":[{"id":"frostveil","runs":[[0,8]]},{"id":"seeker-reach","runs":[[9,11]]},{"id":"crownlands","runs":[[13,23]]}],"genesisRuns":[[9,9]],"seekerRuns":[[10,11]]}"""), 6, 4)
    private fun globe(hash: String = "92a3", ready: Boolean = true) = json("""{"worldId":"fantasy-v1","catalogHash":"$hash","ready":$ready,
        "realms":[{"realmId":"frostveil","total":13126,"occupied":12,"held":1,"available":13113,"anchorTileId":14742}],"me":{"baseId":null,"selectedTileId":null,"ownedTiles":[]}}""")
    private inner class Fixture(catalogue: JsonObject?, world: FantasyCatalog? = frozen) {
        val api = FakeApiClient(); val holder = testHolder(); val session = signedIn(holder)
        var selectedBase: String? = BASE_ID
        val repository = LiveWorldRepository(session, holder, api, { selectedBase }, { catalogue }, { world })
    }

    @Test fun `the globe is read with the selected base and published only when the catalogue matches`() = runBlocking {
        val f = Fixture(catalogue); f.api.onGet("/globe/fantasy") { query -> assertEquals(BASE_ID, query["baseId"]); globe() }
        f.repository.refreshGlobe()
        assertEquals(13113, f.repository.state.value.globe!!.realms.single().available); assertNull(f.repository.state.value.unavailable)
        f.api.onGet("/globe/fantasy") { globe(hash = "ffff") }
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.repository.refreshGlobe() } }
        assertNull(f.repository.state.value.globe); assertTrue(f.repository.state.value.unavailable!!.contains("update"))
    }
    @Test fun `a world that is not enabled is reported as unavailable, other failures as errors`() = runBlocking {
        val f = Fixture(catalogue); f.api.onGet("/globe/fantasy") { throw ApiException(503, "FANTASY_WORLD_NOT_READY", "Fantasy world is not enabled") }
        assertThrows(ApiException::class.java) { runBlocking { f.repository.refreshGlobe() } }
        assertEquals("Fantasy world is not enabled", f.repository.state.value.unavailable); assertNull(f.repository.state.value.error)
        f.api.onGet("/globe/fantasy") { throw java.io.IOException("offline") }
        assertThrows(java.io.IOException::class.java) { runBlocking { f.repository.refreshGlobe() } }
        assertEquals("offline", f.repository.state.value.error)
    }
    @Test fun `parcels and viewport markers are pinned to the request`() = runBlocking {
        val f = Fixture(null)
        f.api.onGet("/globe/fantasy/parcels/7") { json("""{"worldId":"fantasy-v1","tile":{"worldId":"fantasy-v1","tileId":7,"realmId":"frostveil","allocation":"ordinary","lon":-90.00,"lat":22.50},"availability":"available","detail":null}""") }
        assertTrue(f.repository.parcel(7).available)
        f.api.onGet("/globe/fantasy/parcels/1") { json("""{"worldId":"fantasy-v1","tile":{"worldId":"fantasy-v1","tileId":2,"realmId":"frostveil","allocation":"ordinary"},"availability":"available"}""") }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.parcel(1) } }
        f.api.onGet("/globe/fantasy/parcels") { query -> assertEquals(mapOf("x0" to "0", "y0" to "1", "x1" to "5", "y1" to "1", "baseId" to BASE_ID), query)
            json("""{"worldId":"fantasy-v1","scope":{"x0":0,"y0":1,"x1":5,"y1":1},"matched":1,"truncated":false,"markers":[{"tileId":7,"name":"A","keepLevel":3}]}""") }
        assertEquals(7, f.repository.markers(0, 1, 5, 1).markers.single().tileId)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.markers(5, 0, 0, 0) } }
        Unit
    }
    /** A server (or pack) whose idea of the tile drifts from the frozen catalogue must not be draftable: the web
     * refuses such a parcel as "Parcel address mismatch", and a reservation on it would freeze a price for land
     * the shipped world does not describe. */
    @Test fun `a parcel is refused when the server's realm, allocation or world disagree with the frozen catalogue`() = runBlocking {
        val f = Fixture(null)
        fun answer(tile: Int, realm: String, allocation: String, world: String = "fantasy-v1", tileWorld: String = "fantasy-v1") =
            f.api.onGet("/globe/fantasy/parcels/$tile") { json("""{"worldId":"$world","tile":{"worldId":"$tileWorld","tileId":$tile,"realmId":"$realm","allocation":"$allocation"},"availability":"available"}""") }
        answer(7, "crownlands", "ordinary")
        assertEquals("Parcel address mismatch", assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.parcel(7) } }.message)
        answer(9, "seeker-reach", "ordinary")
        assertThrows("A genesis sanctuary tile sold as ordinary", IllegalArgumentException::class.java) { runBlocking { f.repository.parcel(9) } }
        answer(7, "frostveil", "ordinary", tileWorld = "fantasy-v2")
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.parcel(7) } }
        answer(12, "frostveil", "ordinary")
        assertThrows("A tile the frozen world calls sea", IllegalArgumentException::class.java) { runBlocking { f.repository.parcel(12) } }
        answer(9, "seeker-reach", "genesis")
        assertEquals("genesis", f.repository.parcel(9).tile.allocation)
        val unloaded = Fixture(null, world = null); unloaded.api.onGet("/globe/fantasy/parcels/7") { json("""{"worldId":"fantasy-v1","tile":{"worldId":"fantasy-v1","tileId":7,"realmId":"frostveil","allocation":"ordinary"},"availability":"available"}""") }
        assertThrows("Without the frozen catalogue nothing can be verified, so nothing is drafted", IllegalArgumentException::class.java) { runBlocking { unloaded.repository.parcel(7) } }
        Unit
    }
    @Test fun `a base switch fences directory parcel viewport and search responses`() = runBlocking {
        val paths = listOf("/globe/fantasy", "/globe/fantasy/parcels/7", "/globe/fantasy/parcels", "/globe/fantasy/search", "/economy/stats")
        for (path in paths) {
            val f=Fixture(catalogue)
            f.api.onGet(path) {
                f.selectedBase="another-base"
                when(path) {
                    "/globe/fantasy" -> globe()
                    "/globe/fantasy/parcels/7" -> json("""{"worldId":"fantasy-v1","tile":{"worldId":"fantasy-v1","tileId":7,"realmId":"frostveil","allocation":"ordinary"},"availability":"available"}""")
                    "/economy/stats" -> json("""{"warzone":{"active":true}}""")
                    "/globe/fantasy/search" -> json("""{"results":[]}""")
                    else -> json("""{"worldId":"fantasy-v1","scope":{"x0":0,"y0":1,"x1":5,"y1":1},"markers":[]}""")
                }
            }
            assertThrows(gg.pixelkingdomwars.nativeclient.network.SessionSupersededException::class.java) { runBlocking {
                when(path) {
                    "/globe/fantasy" -> f.repository.refreshGlobe()
                    "/globe/fantasy/parcels/7" -> f.repository.parcel(7)
                    "/economy/stats" -> f.repository.warzone()
                    "/globe/fantasy/search" -> f.repository.search("keeper")
                    else -> f.repository.markers(0,1,5,1)
                }
            } }
            assertNull(f.repository.state.value.globe)
        }
    }
    @Test fun `viewport scope and frozen membership prevent foreign markers entering the globe`() = runBlocking {
        val f=Fixture(catalogue)
        f.api.onGet("/globe/fantasy/parcels") { json("""{"worldId":"fantasy-v1","scope":{"x0":0,"y0":1,"x1":5,"y1":1},"markers":[{"tileId":7,"name":"Valid","keepLevel":3},{"tileId":13,"name":"Outside","keepLevel":3},{"tileId":12,"name":"Sea","keepLevel":3},{"tileId":7,"name":"Duplicate","keepLevel":3}]}""") }
        assertEquals(listOf(7),f.repository.markers(0,1,5,1).markers.map{it.tileId})
        f.api.onGet("/globe/fantasy/parcels") { json("""{"worldId":"fantasy-v1","scope":{"x0":0,"y0":0,"x1":5,"y1":1},"markers":[]}""") }
        assertThrows(IllegalArgumentException::class.java) {runBlocking{f.repository.markers(0,1,5,1)}}
        Unit
    }
    @Test fun `owner search validates realm membership and never posts or reads a short term`() = runBlocking {
        val f=Fixture(catalogue)
        assertTrue(f.repository.search(" a ").isEmpty());assertTrue(f.api.gets.isEmpty())
        f.api.onGet("/globe/fantasy/search") { q -> assertEquals("keeper",q["q"]);json("""{"results":[{"tileId":7,"realmId":"frostveil","name":"Keeper","keepLevel":3,"trophies":20},{"tileId":7,"realmId":"crownlands","name":"Wrong","keepLevel":3,"trophies":20}]}""") }
        assertEquals(listOf("Keeper"),f.repository.search(" keeper ").map{it.name});assertTrue(f.api.posts.isEmpty())
    }
}
