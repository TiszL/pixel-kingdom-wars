package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.Building
import org.junit.Assert.*
import org.junit.Test

/** The client highlights the row the server prices: `wallRowThrough` is shared by movement and purchase. */
class WallRowsTest {
    private fun wall(id: String, tx: Int, ty: Int, type: String = "wall") = Building(id, type, 1, tx, ty)
    @Test fun `the longest straight run through the tapped wall wins and horizontal wins ties`() {
        val walls = listOf(wall("a", 1, 5), wall("b", 2, 5), wall("c", 3, 5), wall("d", 2, 4), wall("e", 2, 6), wall("f", 2, 7), wall("g", 9, 9))
        assertEquals(listOf("b", "e", "f", "d"), wallRowThrough(walls, "b").map { it.id })
        assertEquals("A tie goes to the horizontal run", listOf("b", "c", "a"), wallRowThrough(walls.filter { it.id != "f" }, "b").map { it.id })
        assertEquals(listOf("g"), wallRowThrough(walls, "g").map { it.id })
        assertTrue(wallRowThrough(walls, "missing").isEmpty())
    }
    @Test fun `only walls join a run even when another building sits in line`() {
        val walls = listOf(wall("a", 1, 5), wall("cannon", 2, 5, type = "cannon"), wall("c", 3, 5))
        assertEquals(listOf("a"), wallRowThrough(walls, "a").map { it.id })
    }
}
