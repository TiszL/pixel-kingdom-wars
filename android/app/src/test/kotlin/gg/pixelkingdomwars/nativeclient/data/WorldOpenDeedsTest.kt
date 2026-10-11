package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.json
import org.junit.Assert.*
import org.junit.Test

/**
 * Choose mode's "Next open deed ▶" without the occupancy feed (OQ-1's recorded default). The candidate is what the client
 * can honestly call open: an ordinary catalog tile of the realm nobody is known to hold. Offering a Genesis or Seeker
 * tile, another realm's tile, or a kingdom already on screen would send the player to a card that can only say no, and
 * a stepper that bounced between two deeds would never reach new land.
 */
class WorldOpenDeedsTest {
    // 8 × 5 grid. Frostveil: rows 0–1 and cells 16–18; Solana Reach 19–23 (Genesis 19–20, Seeker 21–23); Crownlands 24–39.
    private val world = json("""{"membershipSha256":"t","regions":[{"id":"frostveil","runs":[[0,18]]},{"id":"seeker-reach","runs":[[19,23]]},{"id":"crownlands","runs":[[24,39]]}],"genesisRuns":[[19,20]],"seekerRuns":[[21,23]]}""")
    private val catalog = FantasyCatalog.parse(world, columns = 8, rows = 5)

    @Test fun `the nearest ordinary tile of the realm, never another realm's and never a reserved allocation`() {
        // From inside Solana Reach (x 3, y 2 = tile 19) the nearest Frostveil tile is ring 1, row-major: 10 (x 2, y 1).
        assertEquals(10, WorldOpenDeeds.next(catalog, "frostveil", 3, 2, emptySet(), emptySet()))
        assertNull("Solana Reach has no ordinary land to choose", WorldOpenDeeds.next(catalog, FantasyCatalog.SEEKER_REALM, 3, 2, emptySet(), emptySet()))
        val c = requireNotNull(WorldOpenDeeds.next(catalog, "crownlands", 0, 0, emptySet(), emptySet()))
        assertEquals("crownlands", catalog.tile(c)!!.realmId); assertEquals("ordinary", catalog.tile(c)!!.allocation)
    }

    @Test fun `kingdoms in view and your deeds are skipped, and repeated Next walks on without repeats`() {
        assertEquals("the origin itself when open", 0, WorldOpenDeeds.next(catalog, "frostveil", 0, 0, emptySet(), emptySet()))
        assertEquals("a known kingdom is not open: its neighbour is offered", 0, WorldOpenDeeds.next(catalog, "frostveil", 1, 0, known = setOf(1), skip = emptySet()))
        val offered = LinkedHashSet<Int>(); var x = 0; var y = 0
        repeat(19) {
            val t = WorldOpenDeeds.next(catalog, "frostveil", x, y, known = setOf(5), skip = offered) ?: return@repeat
            assertTrue("never offered twice: $t in $offered", offered.add(t)); x = t % 8; y = t / 8
        }
        assertEquals("every Frostveil tile but the known kingdom, each once", (0..18).toSet() - 5, offered)
        assertNull("nothing left to offer", WorldOpenDeeds.next(catalog, "frostveil", x, y, setOf(5), offered))
    }

    @Test fun `columns wrap at the dateline, rows do not, and the search is bounded`() {
        // Cinderfall-style wrap: from column 0 the tile across the dateline (column 7) is one ring away.
        val open = { t: Int -> t == 7 }
        assertEquals(7, WorldOpenDeeds.next(0, 0, 8, 5, open, emptySet(), emptySet()))
        assertNull("no row wrap: row −1 is not row 4", WorldOpenDeeds.next(0, 0, 8, 5, { it == 39 }, emptySet(), emptySet(), maxRing = 1))
        var calls = 0
        assertNull(WorldOpenDeeds.next(500, 500, 1000, 1000, { calls++; false }, emptySet(), emptySet()))
        assertTrue("≤ (2·MAX_RING + 1)² cells checked on a tap: $calls", calls <= (2 * WorldOpenDeeds.MAX_RING + 1) * (2 * WorldOpenDeeds.MAX_RING + 1))
    }
}
