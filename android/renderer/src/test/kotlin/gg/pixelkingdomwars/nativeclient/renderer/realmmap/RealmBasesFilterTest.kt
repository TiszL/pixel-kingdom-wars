package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * SHARDKEEP D-191 (owner 2026-09-28, endorsing a player: "instead of Shielded … Unshielded: the purpose of searching is to
 * raid, their target should be the unshielded") in the engine's bases table. The feed's `shielded` is true, false or
 * absent, and the FLAG word has no bit for "absent", so the snapshot says which bits it carried ([WorldBases.shieldKnown]).
 * UNSHIELDED may promise a raid target only where the server said `false`: an absent bit is unknown (an older server, or
 * your own deed the feed did not carry), never "open to a raid" (D-169 / D-181: hidden, never faked). And what the filter
 * drops the map hides ([RealmBases.drawn]), the selected kingdom excepted.
 */
class RealmBasesFilterTest {
    /** Four kingdoms: shielded, clear, shielded, clear (levels 3, 9, 12, 20); [shieldKnown] says which bits the read carried. */
    private fun table(shieldKnown: BooleanArray?): RealmBases {
        val b = RealmBases(RealmTestData.plots); b.reset(8, 4)
        val o = RealmBases.FLAG_OCCUPIED; val sh = RealmBases.FLAG_SHIELD
        b.set(WorldBases(1, "alpha", intArrayOf(0, 1, 2, 3), intArrayOf(0, 0, 0, 0), intArrayOf(3, 9, 12, 20), intArrayOf(o or sh, o, o or sh, o), shieldKnown))
        return b
    }

    @Test fun `UNSHIELDED keeps only a shield bit the read carried as false`() {
        val b = table(booleanArrayOf(true, true, false, false))
        b.applyFilter(WorldFilter(WorldFilterKind.UNSHIELDED))
        assertEquals(listOf(false, true, false, false), (0 until 4).map { b.filtered[it] }, "a known clear bit passes; known shielded and both unknown do not")
        assertEquals(1, b.filteredCount)
        assertTrue(b.filterActive)
        b.applyFilter(WorldFilter(WorldFilterKind.UNSHIELDED, 10..20))
        assertEquals(0, b.filteredCount, "the level range still applies first (the clear kingdom is level 9)")
        val none = table(null)
        none.applyFilter(WorldFilter(WorldFilterKind.UNSHIELDED))
        assertEquals(0, none.filteredCount, "a snapshot that carries no bit passes nothing")
        none.applyFilter(WorldFilter(WorldFilterKind.ALL))
        assertEquals(4, none.filteredCount, "and every other chip is unaffected")
    }

    @Test fun `a filtered-out kingdom is not drawn unless it is the selection`() {
        val b = table(BooleanArray(4) { true })
        b.applyFilter(WorldFilter(WorldFilterKind.LEVEL, 7..20))
        assertEquals(listOf(false, true, true, true), (0 until 4).map { b.drawn(it) }, "the level-3 kingdom is hidden, not dimmed")
        b.select(0)
        assertTrue(b.drawn(0), "the selected kingdom always draws: its card is up on it")
        assertEquals(3, b.filteredCount, "the selection changes nothing about the filter or its counts")
        assertFalse(b.filtered[0])
        b.clearSelection()
        assertFalse(b.drawn(0), "deselected, it is hidden again")
        b.applyFilter(WorldFilter(WorldFilterKind.ALL))
        assertTrue((0 until 4).all { b.drawn(it) }, "no filter: every kingdom draws")
    }
}
