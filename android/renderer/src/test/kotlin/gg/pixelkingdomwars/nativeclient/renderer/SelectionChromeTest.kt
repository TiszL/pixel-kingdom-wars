package gg.pixelkingdomwars.nativeclient.renderer

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * The selection marker the owner sees under a tapped building (owner 2026-10-06: the old flat yellow tile "looks ugly").
 * The design (design-beacon final `selected.png`, `voyage/lodge-selected.png`) is a stepped footprint frame on the
 * ground, 7 dp ink under 3 dp gold-hi with a dashed inner ring, plus a 2 dp gold rim on the sprite. These pin the
 * geometry rule the renderer fills, so a regression here is one the player sees: a frame off the footprint, ink that
 * swallows a wall, a translucent fill that blotches where rectangles overlap, a marker that restarts on every refresh.
 */
class SelectionChromeTest {
    private data class R(val x: Float, val y: Float, val w: Float, val h: Float) {
        fun covers(px: Float, py: Float) = px >= x && px <= x + w && py >= y && py <= y + h
        fun overlaps(o: R) = x < o.x + o.w && o.x < x + w && y < o.y + o.h && o.y < y + h
    }
    private fun stroke(x: Float, y: Float, w: Float, h: Float, step: Float, t: Float) =
        mutableListOf<R>().also { out -> SelectionChrome.steppedStroke(x, y, w, h, step, t) { a, b, c, d -> out += R(a, b, c, d) } }
    private fun fill(x: Float, y: Float, w: Float, h: Float, step: Float) =
        mutableListOf<R>().also { out -> SelectionChrome.steppedFill(x, y, w, h, step) { a, b, c, d -> out += R(a, b, c, d) } }
    private fun dashes(x: Float, y: Float, w: Float, h: Float, t: Float, on: Float, off: Float) =
        mutableListOf<R>().also { out -> SelectionChrome.dashedRect(x, y, w, h, t, on, off) { a, b, c, d -> out += R(a, b, c, d) } }

    @Test fun `the design frame of 3 by 2 tiles of 30 dp keeps the selected html weights`() {
        val f = SelectionFrame()
        SelectionChrome.layout(f, 0f, 0f, 90f, 60f, worldPerDp = 1f)
        assertEquals("Full weight at the design's own size", 1f, f.weight, 1e-6f)
        assertEquals(7f, f.ink, 1e-5f); assertEquals(3f, f.rim, 1e-5f); assertEquals(4f, f.step, 1e-5f)
        assertEquals(2f, f.dash, 1e-5f); assertEquals(6f, f.dashOn, 1e-5f); assertEquals(6f, f.dashOff, 1e-5f)
        assertEquals("The frame sits ON the footprint edge, not inside or outside it", 0f, f.x, 1e-5f); assertEquals(90f, f.width, 1e-5f)
        assertEquals("The dashed ring runs 8 dp inside the edge", 8f, f.innerX, 1e-5f); assertEquals(74f, f.innerWidth, 1e-5f)
        assertEquals(44f, f.innerHeight, 1e-5f); assertTrue(f.hasInner)
    }

    @Test fun `strokes are dp on screen so the frame reads the same at every zoom`() {
        val near = SelectionFrame(); val far = SelectionFrame()
        // The same 4 x 4 tile Workshop footprint (128 world units): zoomed in 1 dp = 1 unit, zoomed out 1 dp = 2 units.
        SelectionChrome.layout(near, 0f, 0f, 128f, 128f, worldPerDp = 1f)
        SelectionChrome.layout(far, 0f, 0f, 128f, 128f, worldPerDp = 2f)
        assertEquals(7f, near.ink, 1e-5f)
        assertEquals("Twice the world units per dp: twice the world ink, the same 7 dp on screen", 14f, far.ink, 1e-5f)
    }

    @Test fun `a small piece thins the chrome so 7 dp of ink never swallows it but it never vanishes`() {
        assertEquals(1f, SelectionChrome.weight(60f), 1e-6f); assertEquals(1f, SelectionChrome.weight(240f), 1e-6f)
        assertEquals("Linear below the design size", 0.75f, SelectionChrome.weight(45f), 1e-6f)
        assertEquals("A 28 dp wall at home zoom keeps half weight", 0.5f, SelectionChrome.weight(28f), 1e-6f)
        assertEquals(0.5f, SelectionChrome.weight(0f), 1e-6f); assertEquals(0.5f, SelectionChrome.weight(Float.NaN), 1e-6f)
        val wall = SelectionFrame(); SelectionChrome.layout(wall, 0f, 0f, 28f, 28f, worldPerDp = 1f)
        assertEquals(3.5f, wall.ink, 1e-5f); assertEquals(1.5f, wall.rim, 1e-5f)
        assertTrue("A corner step never eats more than a quarter of the short side", wall.step <= 28f / 4)
        val pebble = SelectionFrame(); SelectionChrome.layout(pebble, 0f, 0f, 12f, 12f, worldPerDp = 1f)
        assertFalse("No room for one dash a side: the inner ring is left out, not crammed in", pebble.hasInner)
    }

    @Test fun `the select motion scales the frame about the footprint centre`() {
        val f = SelectionFrame()
        SelectionChrome.layout(f, 100f, 200f, 64f, 32f, worldPerDp = 1f, scale = 0.8f)
        assertEquals(51.2f, f.width, 1e-4f); assertEquals(25.6f, f.height, 1e-4f)
        assertEquals("Centre stays on the footprint centre", 132f, f.x + f.width / 2, 1e-4f)
        assertEquals(216f, f.y + f.height / 2, 1e-4f)
    }

    @Test fun `the stroke keeps a stepped outer corner and closes every join`() {
        val bars = stroke(0f, 0f, 90f, 60f, step = 4f, t = 7f)
        assertEquals("Four edges and two legs per corner", 12, bars.size)
        fun covered(px: Float, py: Float) = bars.any { it.covers(px, py) }
        assertFalse("The outermost corner pixel is cut away: the corner is stepped, never square", covered(-3f, -3f))
        assertFalse(covered(92.5f, 62.5f)); assertFalse(covered(-3f, 62.5f)); assertFalse(covered(92.5f, -3f))
        // Every point of the path's centre line is inked: no gap at an edge, a step or a join.
        val path = listOf(4f to 0f, 45f to 0f, 86f to 0f, 86f to 2f, 86f to 4f, 88f to 4f, 90f to 4f, 90f to 30f, 90f to 56f,
            88f to 56f, 86f to 56f, 86f to 58f, 86f to 60f, 45f to 60f, 4f to 60f, 4f to 58f, 4f to 56f, 2f to 56f, 0f to 56f,
            0f to 30f, 0f to 4f, 2f to 4f, 4f to 4f, 4f to 2f)
        for ((px, py) in path) assertTrue("path point $px,$py", covered(px, py))
        assertTrue("The ink reaches half a stroke outside the edge", covered(45f, -3.4f)); assertFalse(covered(45f, -3.6f))
        assertEquals("No step: four bars that still close the corners", 4, stroke(0f, 0f, 90f, 60f, step = 0f, t = 3f).size)
        assertTrue(stroke(0f, 0f, 90f, 60f, step = 0f, t = 3f).any { it.covers(-1.4f, -1.4f) })
    }

    @Test fun `the soft fill never overlaps itself so the translucent gold is even`() {
        val parts = fill(0f, 0f, 90f, 60f, step = 4f)
        assertEquals(3, parts.size)
        for (i in parts.indices) for (j in parts.indices) if (i < j) assertFalse("$i overlaps $j", parts[i].overlaps(parts[j]))
        assertEquals("The stepped interior: the box minus the four corner steps", 90f * 60f - 4 * 16f, parts.sumOf { (it.w * it.h).toDouble() }.toFloat(), 1e-2f)
        assertFalse("The cut corner stays clear", parts.any { it.covers(1f, 1f) })
        assertTrue(fill(0f, 0f, 0f, 60f, 4f).isEmpty())
    }

    @Test fun `the dashed ring carries its phase round the corners and never double-blends`() {
        val pieces = dashes(0f, 0f, 10f, 10f, t = 1f, on = 6f, off = 6f)
        // Perimeter 40 walked clockwise from the top-left: on 0-6, 12-18, 24-30, 36-40.
        assertEquals(4, pieces.size)
        assertEquals("Top edge, through the top-left corner square it owns", R(-0.5f, -0.5f, 6.5f, 1f), pieces[0])
        assertEquals("Right edge, 2 to 8 down: the phase carried round the corner", R(9.5f, 2f, 1f, 6f), pieces[1])
        assertEquals("Bottom edge, walked right to left", R(0f, 9.5f, 6f, 1f), pieces[2])
        assertEquals("Left edge, the last 4 up to the start, stopping short of the square the top edge owns",
            R(-0.5f, 0.5f, 1f, 3.5f), pieces[3])
        for (i in pieces.indices) for (j in pieces.indices) if (i < j) assertFalse("$i overlaps $j", pieces[i].overlaps(pieces[j]))
        // A dash that turns a corner (period 7 on a 10-unit side): drawn through the corner once, as an unbroken L.
        val turning = dashes(0f, 0f, 10f, 10f, t = 1f, on = 5f, off = 2f)
        for (i in turning.indices) for (j in turning.indices) if (i < j) assertFalse("$i overlaps $j", turning[i].overlaps(turning[j]))
        assertTrue("The outer corner square is inked", turning.any { it.covers(10.4f, -0.4f) })
        val design = dashes(14f, 12f, 72f, 44f, t = 2f, on = 6f, off = 6f)
        assertEquals("232 dp of ring at a 12 dp period: 20 dashes", 20, design.size)
        for (i in design.indices) for (j in design.indices) if (i < j) assertFalse("$i overlaps $j", design[i].overlaps(design[j]))
        assertTrue(dashes(0f, 0f, 10f, 10f, t = 1f, on = 0f, off = 6f).isEmpty())
        assertTrue("No gap is no dashed ring", dashes(0f, 0f, 10f, 10f, t = 1f, on = 6f, off = 0f).isEmpty())
    }

    @Test fun `the token easings front-load the select and hold back the deselect`() {
        assertEquals(0f, SelectionChrome.easeOut(0f), 0f); assertEquals(1f, SelectionChrome.easeOut(1f), 0f)
        assertTrue("easing.out front-loads the move", SelectionChrome.easeOut(0.5f) > 0.8f)
        assertTrue("easing.in holds back, then leaves", SelectionChrome.easeIn(0.5f) < 0.4f)
        var last = 0f
        for (i in 0..50) { val v = SelectionChrome.easeOut(i / 50f); assertTrue(v >= last - 1e-5f); last = v }
        assertEquals("cubic-bezier(0,0,1,1) is linear", 0.3f, SelectionChrome.cubicBezier(0f, 0f, 1f, 1f, 0.3f), 1e-4f)
        assertEquals(1f, SelectionChrome.easeOut(7f), 0f)
    }

    @Test fun `selecting pops the frame in from 80 percent and fades the sprite rim in over 140 ms`() {
        val m = SelectionMotion()
        assertFalse(m.visible)
        m.show(10f, 12f, 2f, 2f, reducedMotion = false)
        assertTrue(m.visible); assertEquals(0.8f, m.scale, 1e-5f); assertEquals(0f, m.outlineAlpha, 1e-5f)
        assertEquals("The frame itself is opaque: it scales, it does not fade", 1f, m.ringAlpha, 0f)
        m.advance(0.07f)
        assertTrue(m.scale > 0.8f && m.scale < 1f); assertTrue(m.outlineAlpha > 0f && m.outlineAlpha < 1f)
        m.advance(0.08f)
        assertEquals(1f, m.scale, 0f); assertEquals(1f, m.outlineAlpha, 0f)
        assertEquals(10f to 12f, m.tileX to m.tileY)
    }

    @Test fun `a routine refresh with the same footprint never restarts the marker`() {
        val m = SelectionMotion()
        m.show(10f, 12f, 2f, 2f, false); m.advance(1f)
        m.show(10f, 12f, 2f, 2f, false)
        assertEquals("No second pop on a base refresh", 1f, m.scale, 0f); assertEquals(1f, m.outlineAlpha, 0f)
    }

    @Test fun `selecting another building cross-moves the frame there in 140 ms`() {
        val m = SelectionMotion()
        m.show(10f, 10f, 2f, 2f, false); m.advance(1f)
        m.show(20f, 14f, 1f, 1f, false)
        assertEquals("It starts where the last one stood", 10f, m.tileX, 1e-5f); assertEquals(2f, m.width, 1e-5f)
        assertEquals("A move never shrinks or blinks", 1f, m.scale, 0f); assertEquals(1f, m.outlineAlpha, 0f)
        m.advance(0.07f)
        assertTrue(m.tileX > 10f && m.tileX < 20f); assertTrue(m.width < 2f && m.width > 1f)
        m.advance(0.1f)
        assertEquals(20f, m.tileX, 0f); assertEquals(14f, m.tileY, 0f); assertEquals(1f, m.width, 0f)
    }

    @Test fun `deselect plays the reverse in 120 ms then the marker is gone`() {
        val m = SelectionMotion()
        m.show(10f, 10f, 2f, 2f, false); m.advance(1f)
        m.hide()
        assertTrue("It stays to play the reverse", m.visible)
        m.advance(0.06f)
        assertTrue(m.scale < 1f && m.scale > 0.8f); assertTrue(m.outlineAlpha < 1f)
        m.advance(0.07f)
        assertFalse(m.visible); assertEquals(0f, m.outlineAlpha, 0f)
        m.hide(); assertFalse("Hiding a hidden marker does nothing", m.visible)
    }

    @Test fun `reduced motion cross-fades and never scales or travels`() {
        val m = SelectionMotion()
        m.show(10f, 10f, 2f, 2f, reducedMotion = true)
        assertEquals(1f, m.scale, 0f); assertEquals(0f, m.ringAlpha, 1e-5f)
        m.advance(0.12f)
        assertEquals(1f, m.ringAlpha, 0f); assertEquals(1f, m.outlineAlpha, 0f)
        m.show(20f, 10f, 2f, 2f, reducedMotion = true)
        assertEquals("No travel: it appears at the new building", 20f, m.tileX, 0f); assertEquals(1f, m.scale, 0f)
        m.advance(1f); m.hide(); m.advance(0.06f)
        assertEquals(1f, m.scale, 0f); assertTrue(m.ringAlpha < 1f)
        m.advance(-5f); assertTrue("A negative frame delta never runs the clock back", m.visible && m.ringAlpha < 1f)
    }

    @Test fun `a highlight names what it marks and the row piece kind exists for wall rows`() {
        assertNull(SceneHighlight(1f, 1f, 1f, 1f, 0, .5f).targetId)
        val piece = SceneHighlight(1f, 1f, 1f, 1f, SelectionChrome.GOLD_HI, .18f, SceneHighlightKind.OUTLINE, targetId = "w1")
        assertEquals("w1", piece.targetId); assertEquals(SceneHighlightKind.OUTLINE, piece.kind)
        assertEquals("TOKENS.json gold.hi", 0xFFE38A, SelectionChrome.GOLD_HI); assertEquals("TOKENS.json ink", 0x140F17, SelectionChrome.INK)
        assertEquals("TOKENS.json gold", 0xE3AE3C, SelectionChrome.GOLD)
    }

    /** The renderer's passes need a GL batch, so the draw ORDER is pinned in source, as RealmKitPropPassTest does. */
    @Test fun `the frame lies under the sprites and the gold rim goes down under the selected sprite own layers`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/NativeGameRenderer.kt").readText()
        fun member(declaration: String): String {
            val start = source.indexOf(declaration); assertTrue("missing $declaration", start >= 0)
            return source.substring(start, source.indexOf("\n    }\n", start))
        }
        val fills = source.indexOf("drawHighlightFills(active)"); val base = source.indexOf("drawBase(System.currentTimeMillis())")
        val strokes = source.indexOf("drawHighlightStrokes(active)\n")
        assertTrue("The frame is ground chrome: drawn before the base sprites", fills in 0 until base)
        assertTrue(strokes > base)
        assertTrue("drawSelectionFrame(" in member("private fun drawHighlightFills("))
        assertFalse("No selection chrome above the art: the old yellow tile outline and ticks are gone",
            "drawSelectionFrame(" in member("private fun drawHighlightStrokes(") || "cornerTicks(" in source.substringAfter("private fun drawStrokes("))
        val loop = member("private fun drawBase(")
        val rim = loop.indexOf("drawOutlineRun(index,outline)"); val own = loop.indexOf("item.region?.let", rim)
        assertTrue("The rim is drawn first, then the sprite's own layer covers all but the rim", rim >= 0 && own > rim)
    }
}
