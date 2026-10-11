package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Assert.*
import org.junit.Test

class WallStrokeInputTest {
    private val tiles = (0 until 12).flatMap { y -> (0 until 12).map { x -> WallStrokeTile(x, y) } }.toSet()
    private val mode = WallStrokeMode("original", "A", 12, 12, 1, 1, tiles - WallStrokeTile(4, 4))
    private class Fixture(val mode: WallStrokeMode) {
        val events = mutableListOf<WallStrokeEvent>(); val input = WallStrokeInput { events += it }
        init { frame() }
        fun frame(next: WallStrokeMode? = mode, revision: Long = 1, base: String = "A", battle: Boolean = false, width: Int = 120) = input.frame(next, revision, base, battle, width, 120)
        fun release() = events.filterIsInstance<WallStrokeEvent.Released>()
    }
    @Test fun `fast swipe samples endpoints only and releases a single ordered noninterpolated batch`() {
        val f = Fixture(mode); assertTrue(f.input.down(0, true, true)); assertTrue(f.events.isEmpty())
        f.input.move(0, 1.5f, 2.5f, true); f.input.move(0, 9.5f, 2.5f, true)
        f.input.move(0, 1.5f, 2.5f, true); f.input.up(0, 10.5f, 2.5f, true)
        assertEquals(listOf(WallStrokeTile(1, 2), WallStrokeTile(9, 2)), f.release().single().tiles)
        assertTrue(f.input.highlights.isEmpty())
    }
    @Test fun `pure tap samples release at source round boundary and clamps plot edges`() {
        for ((point, expected) in listOf(.99f to 0, 1f to 1, -30f to 0, 90f to 11)) {
            val f = Fixture(mode); f.input.down(0, true, true); f.input.up(0, point, 2f, true)
            assertEquals(listOf(WallStrokeTile(expected, 2)), f.release().single().tiles)
        }
    }
    @Test fun `blocked geometry and invalid samples are skipped without converting them into walls`() {
        val f = Fixture(mode); f.input.down(0, true, true)
        f.input.move(0, Float.NaN, 2f, true); f.input.move(0, 4.5f, 4.5f, true); f.input.move(0, 2f, 3f, true)
        assertEquals(1, f.input.highlights.size); val highlight = f.input.highlights.single()
        assertEquals(0x5FE36A, highlight.color); assertEquals(.5f, highlight.alpha)
        assertEquals("A painted tile is a plain fill above the sprites, never selection chrome", SceneHighlightKind.FILL, highlight.kind)
        f.input.up(0, 4f, 4f, true); assertEquals(listOf(WallStrokeTile(2, 3)), f.release().single().tiles)
    }
    @Test fun `budget and cap cannot silently trim a geometry-valid stroke`() {
        val f = Fixture(mode); f.input.down(0, true, true)
        tiles.filter { it in mode.validTiles }.forEach { f.input.move(0, it.tx.toFloat(), it.ty.toFloat(), true) }
        f.input.up(0, 0f, 0f, true)
        assertEquals(mode.validTiles.size, f.release().single().tiles.size)
    }
    @Test fun `pinch erases purchase candidate and remaining finger is camera-only until every contact lifts`() {
        val f = Fixture(mode); f.input.down(0, true, true); f.input.move(0, 2f, 2f, true)
        assertFalse(f.input.down(1, true, true)); assertTrue(f.input.highlights.isEmpty())
        f.input.up(1, 3f, 2f, true); assertFalse(f.input.move(0, 5f, 2f, true)); f.input.up(0, 5f, 2f, true)
        assertTrue(f.release().isEmpty()); assertTrue(f.input.down(0, true, true)); f.input.up(0, 5f, 2f, true)
        assertEquals(listOf(WallStrokeTile(5, 2)), f.release().single().tiles)
    }
    @Test fun `outside release platform cancellation and pause never purchase a clamped last tile`() {
        for (cancel in 0..2) {
            val f = Fixture(mode); f.input.down(0, true, true); f.input.move(0, 2f, 2f, true)
            when (cancel) { 0 -> f.input.up(0, -100f, 2f, false); 1 -> f.input.cancel(0); else -> f.input.reset() }
            f.input.up(0, 2f, 2f, true); assertTrue(f.release().isEmpty()); assertTrue(f.input.highlights.isEmpty())
        }
    }
    @Test fun `scene viewport mode base and raid changes revoke an in-flight stroke and cannot resume its release`() {
        for (change in 0..5) {
            val f = Fixture(mode); f.input.down(0, true, true); f.input.move(0, 2f, 2f, true)
            when (change) { 0 -> f.frame(revision = 2); 1 -> f.frame(width = 80); 2 -> f.frame(next = null)
                3 -> f.frame(base = "B"); 4 -> f.frame(battle = true); else -> f.frame(next = mode.copy(token = "new")) }
            f.frame(); assertFalse(f.input.move(0, 3f, 2f, true)); f.input.up(0, 3f, 2f, true)
            assertTrue(f.release().isEmpty()); assertTrue(f.input.highlights.isEmpty())
        }
    }
    @Test fun `a consumed drawing token cannot release twice even after a temporarily unready scene`() {
        val f = Fixture(mode); f.input.down(0, true, true); f.input.up(0, 2f, 2f, true)
        f.frame(next = null); f.frame(); assertFalse(f.input.down(0, true, true)); f.input.up(0, 3f, 3f, true)
        assertEquals(1, f.release().size)
        f.frame(next = mode.copy(token = "fresh")); assertTrue(f.input.down(0, true, true)); f.input.up(0, 3f, 3f, true)
        assertEquals(2, f.release().size)
    }
    @Test fun `ordinary camera mode secondary button and offscreen down cannot acquire wall input`() {
        val f = Fixture(mode); f.frame(next = null); assertFalse(f.input.down(0, true, true)); assertFalse(f.input.move(0, 2f, 2f, true)); f.input.up(0, 2f, 2f, true)
        f.frame(); assertFalse(f.input.down(0, false, true)); f.input.up(0, 2f, 2f, true)
        assertFalse(f.input.down(0, true, false)); f.input.up(0, 2f, 2f, true); assertTrue(f.release().isEmpty())
    }
}
