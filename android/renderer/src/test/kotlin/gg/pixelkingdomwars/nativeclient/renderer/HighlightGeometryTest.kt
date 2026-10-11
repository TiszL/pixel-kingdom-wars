package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.test.assertFailsWith
import org.junit.Assert.*
import org.junit.Test

/** The selection / placement chrome is pure geometry: the renderer only fills what these return, so a
 * regression here is a regression the player sees (an outline that swallows a wall, a grid off by a tile). */
class HighlightGeometryTest {
    private fun overlaps(a: HighlightRect, b: HighlightRect) =
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

    @Test fun `an outline is four bars centred on the edges that never overlap each other`() {
        val bars = HighlightGeometry.outlineSegments(10f, 20f, 40f, 30f, 2f)
        assertEquals(4, bars.size)
        assertEquals("Top bar starts half a stroke outside the corner", HighlightRect(9f, 19f, 42f, 2f), bars[0])
        assertEquals(HighlightRect(9f, 49f, 42f, 2f), bars[1])
        assertEquals("Side bars fit between the top and bottom bars", HighlightRect(9f, 21f, 2f, 28f), bars[2])
        assertEquals(HighlightRect(49f, 21f, 2f, 28f), bars[3])
        for (i in bars.indices) for (j in bars.indices) if (i != j) assertFalse("Translucent bars must not double-blend", overlaps(bars[i], bars[j]))
        val area = bars.sumOf { (it.width * it.height).toDouble() }
        assertEquals("The band area equals the outer rectangle minus the inner one", 42.0 * 32 - 38.0 * 28, area, 1e-3)
    }
    @Test fun `corner ticks are eight arms hugging the four corners`() {
        val ticks = HighlightGeometry.cornerTicks(0f, 0f, 100f, 60f, 6f, 4f)
        assertEquals(8, ticks.size)
        assertEquals("Top-left horizontal arm", HighlightRect(-2f, -2f, 6f, 4f), ticks[0]); assertEquals(HighlightRect(-2f, -2f, 4f, 6f), ticks[1])
        assertEquals("Top-right arm ends flush with the outline's outer edge", HighlightRect(96f, -2f, 6f, 4f), ticks[2])
        assertEquals("Bottom-right vertical arm", HighlightRect(98f, 56f, 4f, 6f), ticks[5])
        assertEquals("Bottom-left horizontal arm", HighlightRect(-2f, 58f, 6f, 4f), ticks[6])
        assertTrue("Every arm stays within the bracket band around the rectangle", ticks.all { it.x >= -2f && it.y >= -2f && it.x + it.width <= 102f && it.y + it.height <= 62f })
    }
    @Test fun `a one-tile footprint keeps its outline but drops the ticks`() {
        assertEquals("A wall is one tile: brackets would swamp it", 0f, HighlightGeometry.tickLength(1f, 1f, 6f))
        assertEquals(6f, HighlightGeometry.tickLength(2f, 2f, 6f)); assertEquals(6f, HighlightGeometry.tickLength(1f, 3f, 6f))
        assertEquals("Zoomed out, a bracket never exceeds a third of the footprint's short side", 4f, HighlightGeometry.tickLength(2f, 2f, 6f, shortSideWorld = 12f))
        assertEquals(6f, HighlightGeometry.tickLength(2f, 2f, 6f, shortSideWorld = 60f))
    }
    @Test fun `grid lines cover every tile edge of the claim including both outer edges`() {
        val lines = HighlightGeometry.gridLines(8f * 32, 8f * 32, 14, 14, 32f, 1f)
        assertEquals(15 + 15, lines.size)
        val verticals = lines.take(15); val horizontals = lines.drop(15)
        assertEquals("First vertical line sits on the claim's west edge", 256f - .5f, verticals.first().x)
        assertEquals("Last vertical line sits on the claim's east edge (tile 22)", 22f * 32 - .5f, verticals.last().x)
        assertTrue(verticals.all { it.width == 1f && it.height == 14f * 32 + 1f })
        assertEquals(256f - .5f, horizontals.first().y); assertEquals(22f * 32 - .5f, horizontals.last().y)
        assertTrue(horizontals.all { it.height == 1f && it.width == 14f * 32 + 1f })
        assertFailsWith<IllegalArgumentException> { HighlightGeometry.gridLines(0f, 0f, 0, 3, 32f, 1f) }
    }
    @Test fun `footprint colour follows what the app knows of validity`() {
        assertEquals(HighlightColors.VALID, HighlightColors.footprint(true))
        assertEquals(HighlightColors.BLOCKED, HighlightColors.footprint(false))
        assertEquals("Only the server can answer: neutral gold, never a guess", HighlightColors.GOLD, HighlightColors.footprint(null))
        assertEquals("Palette.gold", 0xE3AE3C, HighlightColors.GOLD); assertEquals("Palette.goldHi", 0xF4D77B, HighlightColors.GOLD_HI)
        assertEquals("Web VALID_TINT", 0x8CB36E, HighlightColors.VALID); assertEquals("Web BLOCKED_TINT", 0xC75A2E, HighlightColors.BLOCKED)
    }
    @Test fun `breathing runs on the frame clock and stays still under reduced motion`() {
        assertEquals(0f, HighlightGeometry.breath(0f, reducedMotion = false), 1e-6f)
        assertEquals(1f, HighlightGeometry.breath(0.8f, reducedMotion = false), 1e-5f)
        assertEquals("One full period returns to rest", 0f, HighlightGeometry.breath(1.6f, reducedMotion = false), 1e-5f)
        assertEquals("A clock far past one period still wraps", HighlightGeometry.breath(0.4f, false), HighlightGeometry.breath(0.4f + 1.6f * 100, false), 1e-3f)
        for (t in 0..64) { val v = HighlightGeometry.breath(t / 20f, false); assertTrue(v in 0f..1f) }
        assertEquals(0f, HighlightGeometry.breath(0.8f, reducedMotion = true))
        assertEquals("Density × zoom converts a dp stroke into world units", 6f, HighlightGeometry.worldPerDp(2.5f, 2.4f), 1e-6f)
    }
    @Test fun `a highlight without a kind is a plain fill so wall strokes keep their look`() {
        assertEquals(SceneHighlightKind.FILL, SceneHighlight(1f, 1f, 1f, 1f, 0x5FE36A, .5f).kind)
        assertFailsWith<IllegalArgumentException> { SceneHighlight(1f, 1f, 0f, 1f, 0, .5f, SceneHighlightKind.GRID) }
    }
}
