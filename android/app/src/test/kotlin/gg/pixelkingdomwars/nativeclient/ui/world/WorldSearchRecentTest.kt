package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.model.FantasySearchResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * map-search (SPEC §2.4): with an empty query the drawer shows RECENT, up to five kingdoms the player chose GO on. A GO on a
 * RECENT row resolves against these retained rows, so the list must hold exactly what was chosen (newest first, one row per
 * deed, no more than the drawer shows) and must never be rewritten by a later query. Each case fails if that rule moves.
 */
class WorldSearchRecentTest {
    private fun kingdom(tile: Int, realm: String = "frostveil", name: String = "Kingdom $tile", level: Int = 8) =
        FantasySearchResult(tileId = tile, realmId = realm, name = name, keepLevel = level, trophies = 1_000 + tile)

    /** The player's last choice is the first row: RECENT is a way back to where they just were. */
    @Test fun `the newest choice comes first`() {
        val recent = WorldSearchRecent()
        recent.record(kingdom(1)); recent.record(kingdom(2)); recent.record(kingdom(3))
        assertEquals(listOf(3, 2, 1), recent.rows().map { it.tileId })
    }

    /** One deed is one row: choosing a kingdom again moves it up instead of listing it twice, and the drawer's row id
     *  (realm and tile) stays unique, so a GO can never resolve to the wrong one of two copies. */
    @Test fun `choosing a kingdom again moves it to the top without a duplicate`() {
        val recent = WorldSearchRecent()
        recent.record(kingdom(1)); recent.record(kingdom(2)); recent.record(kingdom(1))
        assertEquals(listOf(1, 2), recent.rows().map { it.tileId })
        val ids = recent.rows().map { worldSearchRowId(it.realmId, it.tileId) }
        assertEquals(ids.distinct(), ids)
    }

    /** The same tile number in another realm is another deed (the row id carries the realm), so both rows stay. */
    @Test fun `the same tile in two realms is two rows`() {
        val recent = WorldSearchRecent()
        recent.record(kingdom(42, realm = "frostveil")); recent.record(kingdom(42, realm = "sunscar"))
        assertEquals(listOf("sunscar", "frostveil"), recent.rows().map { it.realmId })
    }

    /** The drawer shows at most five rows for an empty query; more kept here would be rows a player can never reach. */
    @Test fun `the list keeps the five newest and drops the oldest`() {
        val recent = WorldSearchRecent()
        (1..7).forEach { recent.record(kingdom(it)) }
        assertEquals(listOf(7, 6, 5, 4, 3), recent.rows().map { it.tileId })
        val small = WorldSearchRecent(limit = 2)
        (1..3).forEach { small.record(kingdom(it)) }
        assertEquals(listOf(3, 2), small.rows().map { it.tileId })
    }

    /** Recent must fly to the kingdom the player chose, not to whatever the last query returned: the row comes back as the
     *  same result that was recorded, after the query is cleared and after a later search returns other kingdoms. */
    @Test fun `a recorded result comes back intact after the query is cleared`() {
        val recent = WorldSearchRecent()
        val chosen = kingdom(1450, name = "Kaly", level = 8)
        recent.record(chosen)
        // a later query lists another kingdom under a similar name; the player clears it without choosing
        val laterQuery = listOf(kingdom(9, name = "Kalyra", level = 17))
        assertTrue(laterQuery.none { it.tileId == chosen.tileId })
        val row = recent.rows().single()
        assertSame("the retained row is the chosen result itself", chosen, row)
        assertEquals("Kaly", row.name); assertEquals(8, row.keepLevel); assertEquals("frostveil", row.realmId)
    }

    /** A list already drawn is a snapshot: a GO recorded while it is on screen does not shift the rows under the finger. */
    @Test fun `rows already handed out do not change when another choice is recorded`() {
        val recent = WorldSearchRecent()
        recent.record(kingdom(1))
        val drawn = recent.rows()
        recent.record(kingdom(2))
        assertEquals(listOf(1), drawn.map { it.tileId })
        assertEquals(listOf(2, 1), recent.rows().map { it.tileId })
    }
}
