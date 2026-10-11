package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.json
import org.junit.Assert.*
import org.junit.Test

/** The frozen geography reader mirrors `fantasyWorld.ts`: runs partition the grid, sanctuaries partition Solana Reach, tiles derive their realm and coordinates. */
class FantasyCatalogTest {
    private val world = json("""{"schemaVersion":1,"membershipSha256":"c147","regions":[{"id":"frostveil","runs":[[0,5],[6,8]]},{"id":"seeker-reach","runs":[[9,11]]},{"id":"crownlands","runs":[[13,23]]}],"genesisRuns":[[9,9]],"seekerRuns":[[10,11]]}""")
    private val catalog = FantasyCatalog.parse(world, columns = 6, rows = 4)

    @Test fun `tiles resolve their realm, allocation and quarter degree coordinates`() {
        val tile = requireNotNull(catalog.tile(7))
        assertEquals("frostveil", tile.realmId); assertEquals("ordinary", tile.allocation); assertEquals(1, catalog.x(7)); assertEquals(1, catalog.y(7))
        assertEquals("-90.00", tile.lon); assertEquals("22.50", tile.lat)
        assertEquals("genesis", catalog.tile(9)!!.allocation); assertEquals("seeker", catalog.tile(11)!!.allocation)
        assertNull("A cell off every realm is sea", catalog.tile(12)); assertNull(catalog.tile(24)); assertNull(catalog.tile(-1))
        assertEquals(7, catalog.tileAt(1, 1)); assertNull(catalog.tileAt(6, 0))
        assertEquals("c147", catalog.membershipHash); assertEquals(24, catalog.totalCells)
    }
    @Test fun `ordinary tiles are listed per realm in tile order and Solana Reach offers none`() {
        assertEquals(listOf(3, 4, 5, 6), catalog.ordinaryTiles("frostveil", from = 3, limit = 4))
        assertEquals(listOf(0, 1, 2, 3, 4, 5, 6, 7, 8), catalog.ordinaryTiles("frostveil", limit = 100))
        assertTrue(catalog.ordinaryTiles(FantasyCatalog.SEEKER_REALM, limit = 10).isEmpty())
        assertEquals(listOf(13, 14), catalog.ordinaryTiles("crownlands", limit = 2)); assertTrue(catalog.ordinaryTiles("nowhere", limit = 2).isEmpty())
        assertEquals(11, catalog.realmCells("crownlands"))
    }
    @Test fun `overlapping runs and sanctuaries outside Solana Reach are refused`() {
        assertThrows(IllegalArgumentException::class.java) { FantasyCatalog.parse(json("""{"membershipSha256":"x","regions":[{"id":"a","runs":[[0,5]]},{"id":"b","runs":[[5,6]]}]}"""), 6, 4) }
        assertThrows(IllegalArgumentException::class.java) { FantasyCatalog.parse(json("""{"membershipSha256":"x","regions":[{"id":"a","runs":[[0,5]]}],"genesisRuns":[[1,1]]}"""), 6, 4) }
        assertThrows(IllegalArgumentException::class.java) { FantasyCatalog.parse(json("""{"membershipSha256":"x","regions":[{"id":"a","runs":[[0,30]]}]}"""), 6, 4) }
    }
}
