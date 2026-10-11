package gg.pixelkingdomwars.nativeclient.ui.kit

import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/**
 * The SOL mark (SolanaMark.kt). The owner asked for a Solana logo that reads as Solana: three bars with the middle one
 * mirrored, 45 degree ends, bar to gap 2 to 1, the brand gradient from purple at the bottom left to green at the top
 * right, an ink ring so the light green end survives parchment, and a whole-number scale that fits its box. Pure grid,
 * palette and geometry checks; this does not claim a device screenshot.
 */
class SolanaMarkTest {
    private fun isStep(c: Char) = c in '0'..'5'

    private val fillRows = SOLANA_MARK.indices.filter { y -> SOLANA_MARK[y].any { isStep(it) } }

    /** First and last gradient column of row [y]. */
    private fun span(y: Int): IntRange = SOLANA_MARK[y].indexOfFirst { isStep(it) }..SOLANA_MARK[y].indexOfLast { isStep(it) }

    /** The fill rows grouped into bars of consecutive rows, top to bottom. */
    private fun bars(): List<List<Int>> {
        val groups = mutableListOf<MutableList<Int>>()
        for (y in fillRows) if (groups.isNotEmpty() && groups.last().last() == y - 1) groups.last().add(y) else groups.add(mutableListOf(y))
        return groups
    }

    @Test fun `the mark is a 21 by 18 grid of clear ink and the six gradient steps`() {
        assertEquals(SOLANA_MARK_H, SOLANA_MARK.size)
        SOLANA_MARK.forEach { row ->
            assertEquals(row, SOLANA_MARK_W, row.length)
            assertTrue(row, row.all { it == '.' || it == 'x' || isStep(it) })
        }
        assertEquals(6, SOLANA_GRADIENT_ARGB.size)
    }

    @Test fun `the logomark is three bars of four rows with two row gaps and equal length rows`() {
        val bars = bars()
        assertEquals(listOf(4, 4, 4), bars.map { it.size })
        assertEquals("the gap is half a bar, as in the logomark", listOf(2, 2),
            listOf(bars[1].first() - bars[0].last() - 1, bars[2].first() - bars[1].last() - 1))
        for (y in fillRows) {
            val s = span(y)
            assertEquals("row $y is one bar length", 16, s.last - s.first + 1)
            assertTrue("row $y has no hole", SOLANA_MARK[y].substring(s.first, s.last + 1).all { isStep(it) })
        }
    }

    @Test fun `top and bottom bars lean the same way at forty five degrees and the middle bar is mirrored`() {
        val (top, middle, bottom) = bars()
        for (bar in listOf(top, bottom)) bar.zipWithNext().forEach { (a, b) ->
            assertEquals("row $b starts one pixel left of row $a", span(a).first - 1, span(b).first)
        }
        middle.zipWithNext().forEach { (a, b) -> assertEquals("mirrored: row $b starts one pixel right of row $a", span(a).first + 1, span(b).first) }
        // The zig-zag edge of the logomark: each bar's outer corner lines up with the next bar's.
        assertEquals(span(top.last()).first, span(middle.first()).first)
        assertEquals(span(middle.last()).first, span(bottom.first()).first)
        assertEquals(span(top.first()).last, span(middle.last()).last)
        assertEquals(span(middle.last()).last, span(bottom.first()).last)
    }

    @Test fun `the colour runs from Solana purple at the bottom left to Solana green at the top right`() {
        val bottom = fillRows.last()
        val top = fillRows.first()
        assertEquals('0', SOLANA_MARK[bottom][span(bottom).first])
        assertEquals('5', SOLANA_MARK[top][span(top).last])
        for (y in fillRows) {
            val steps = SOLANA_MARK[y].filter { isStep(it) }.toList()
            assertEquals("row $y never gets more purple to the right", steps.sorted(), steps)
        }
        for (x in 0 until SOLANA_MARK_W) {
            val steps = SOLANA_MARK.map { it[x] }.filter { isStep(it) }
            assertEquals("column $x never gets greener going down", steps.sortedDescending(), steps)
        }
        assertEquals("every step is used", ('0'..'5').toList(), SOLANA_MARK.flatMap { r -> r.filter { isStep(it) }.toList() }.distinct().sorted())
    }

    @Test fun `every bar is ringed in ink so the green end reads on parchment and no ink floats free`() {
        fun at(x: Int, y: Int): Char = SOLANA_MARK.getOrNull(y)?.getOrNull(x) ?: '.'
        val around = listOf(1 to 0, -1 to 0, 0 to 1, 0 to -1)
        for (y in SOLANA_MARK.indices) for (x in 0 until SOLANA_MARK_W) {
            val cell = at(x, y)
            if (isStep(cell)) around.forEach { (dx, dy) -> assertTrue("($x, $y) touches the clear background", at(x + dx, y + dy) != '.') }
            if (cell == 'x') assertTrue("ink at ($x, $y) outlines a bar", around.any { (dx, dy) -> isStep(at(x + dx, y + dy)) })
        }
    }

    @Test fun `the six steps are Solana purple and Solana green and even blends between them`() {
        assertEquals(0xFF9945FF, SOLANA_GRADIENT_ARGB.first())
        assertEquals(0xFF14F195, SOLANA_GRADIENT_ARGB.last())
        fun channel(argb: Long, shift: Int): Int = ((argb shr shift) and 0xFF).toInt()
        SOLANA_GRADIENT_ARGB.forEachIndexed { i, argb ->
            assertEquals("step $i is opaque", 0xFF, channel(argb, 24))
            for (shift in listOf(16, 8, 0)) {
                val from = channel(0xFF9945FF, shift)
                val blend = from + (channel(0xFF14F195, shift) - from) * i / 5.0
                assertTrue("step $i channel at bit $shift is the even blend", abs(channel(argb, shift) - blend) <= 0.5)
            }
        }
    }

    @Test fun `at Seeker density the pill sizes draw at a whole scale that fills without overflowing`() {
        val density = 2.625f
        val expected = mapOf(12 to 1, 16 to 2, 20 to 2, 24 to 3, 36 to 4, 48 to 5)
        for ((dp, k) in expected) assertEquals("$dp dp", k, solanaMarkScale(dp * density, dp * density))
    }

    @Test fun `the mark never outgrows its box nor the scale of its 24 px neighbours`() {
        for (density in listOf(1f, 1.5f, 2f, 2.625f, 2.75f, 3f, 3.5f, 4f)) for (dp in listOf(12, 16, 20, 24, 28, 32, 36, 48, 56, 64)) {
            val box = dp * density
            val k = solanaMarkScale(box, box)
            assertTrue("$dp dp at $density draws", k >= 1)
            assertTrue("$dp dp at $density is no coarser than a 24 px icon there", k <= integerArtScale(box, 24))
            if (box >= SOLANA_MARK_W) {
                assertTrue("$dp dp at $density fits", SOLANA_MARK_W * k <= box + 1e-3f && SOLANA_MARK_H * k <= box + 1e-3f)
            }
        }
    }

    @Test fun `an empty or invalid box draws nothing`() {
        for (box in listOf(0f, -1f, 0.5f, Float.NaN, Float.POSITIVE_INFINITY)) {
            assertEquals(0, solanaMarkScale(box, 24f))
            assertEquals(0, solanaMarkScale(24f, box))
        }
    }

    @Test fun `every SOL price and wallet icon draws the mark and no other icon does`() {
        assertTrue(isSolanaMark(currencyIcon(Currency.SOL)))
        assertTrue(isSolanaMark("ui_icon_sol"))
        for (other in listOf("ui:solana-navigation", "solana-navigation", "league-sol", "skr", "keep", "shards", "gem", "Sol", ""))
            assertFalse(other, isSolanaMark(other))
        Currency.entries.filter { it != Currency.SOL }.forEach { assertFalse(it.name, isSolanaMark(currencyIcon(it))) }
    }

    @Test fun `both icon renderers draw the mark before looking up the old bitmap`() {
        val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"
        val kit = File("$root/ui/kit/PkwIcon.kt").readText()
        val gameArt = File("$root/ui/chrome/PixelArt.kt").readText().substringAfter("@Composable fun GameArt(")
        assertTrue("PkwIcon", kit.indexOf("if (isSolanaMark(name))") in 0 until kit.indexOf("val id = kitDrawable(name)"))
        assertTrue("GameArt", gameArt.indexOf("if (isSolanaMark(name))") in 0 until gameArt.indexOf("val resource = artResource(name)"))
    }
}
