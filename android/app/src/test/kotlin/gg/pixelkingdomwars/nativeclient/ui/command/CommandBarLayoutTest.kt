package gg.pixelkingdomwars.nativeclient.ui.command

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The selected-building surfaces (DESIGN-SYSTEM §6 CommandBar / NamePlate, buildings/SPEC.md §1.3). Why these rules
 * matter: the player has just tapped a building to act on it, so the bar must never hide that building, never put a
 * button where a thumb cannot reach it (off screen, under the gesture bar), keep the primary under the right thumb, and
 * never silently lose INFO or the primary on a narrow phone.
 */
class CommandBarLayoutTest {
    private val d = 2f // 2 px per dp keeps the arithmetic exact
    private val w = 412 * d
    private val h = 915 * d
    private val none = PxInsets()
    private fun dp(v: Float) = v * d
    private val info = CommandSlotSpec(primary = false, priced = false)
    private val upgrade = CommandSlotSpec(primary = false, priced = true)
    private val primary = CommandSlotSpec(primary = true, priced = false)
    private fun sprite(leftDp: Float, topDp: Float, sizeDp: Float = 84f) = PxRect(dp(leftDp), dp(topDp), dp(leftDp + sizeDp), dp(topDp + sizeDp))

    @Test fun `the bar sits where the mock puts it - INFO first, primary last under the right thumb`() {
        val p = commandBarPlacement(w, h, d, none, listOf(info, upgrade, primary), anchor = sprite(246f, 288f), hint = false)
        assertEquals(BarSide.BOTTOM, p.side)
        assertFalse(p.coversAnchor)
        val (a, b, c) = p.slots
        assertEquals(dp(16f), a.button.left); assertEquals(dp(808f), a.button.top); assertEquals(dp(68f), a.button.width)
        assertEquals("secondaries are 88 dp apart", dp(104f), b.button.left)
        assertEquals("a priced command's pill starts 30 dp above its face", dp(778f), b.column.top)
        assertEquals("the primary is 120 x 92 at W-136, top H-127", dp(276f), c.button.left)
        assertEquals(dp(788f), c.button.top); assertEquals(dp(120f), c.button.width); assertEquals(dp(92f), c.button.height)
        assertEquals("shelf step at H-163", dp(752f), p.step.top)
        assertEquals(dp(768f), p.band.top); assertEquals(h, p.band.bottom)
        assertNull(p.hintTop)
    }

    @Test fun `in the bottom position every command stays inside the deck area above the gesture inset`() {
        val insets = PxInsets(bottom = dp(24f), top = dp(32f))
        val p = commandBarPlacement(w, h, d, insets, listOf(info, upgrade, CommandSlotSpec(primary = true, priced = true)), anchor = null, hint = false)
        val deckTop = h - insets.bottom - dp(163f)
        val deckBottom = h - insets.bottom
        p.slots.forEach {
            assertTrue("$it starts below the deck top", it.column.top >= deckTop)
            assertTrue("$it ends above the gesture inset", it.column.bottom <= deckBottom)
        }
    }

    @Test fun `a building standing in the bottom band flips the bar under the resource stack instead of covering it`() {
        val anchor = sprite(160f, 790f)
        val p = commandBarPlacement(w, h, d, none, listOf(info, upgrade, primary), anchor, hint = false)
        assertEquals(BarSide.TOP, p.side)
        assertFalse(p.coversAnchor)
        assertFalse(p.footprint.intersects(anchor))
        val stack = resourceStackRect(w, d)
        p.slots.forEach { assertTrue("$it clears the stack", it.column.top >= stack.bottom) }
        assertTrue("the shelf does not paint over the stack", p.band.top >= stack.bottom)
    }

    @Test fun `the hint pill counts as part of the bar - a building behind it also flips the bar`() {
        val anchor = sprite(160f, 640f, 76f) // bottom at 716: clear of the shelf (752), not of the hint (714)
        assertEquals(BarSide.BOTTOM, commandBarPlacement(w, h, d, none, listOf(info, primary), anchor, hint = false).side)
        val withHint = commandBarPlacement(w, h, d, none, listOf(info, primary), anchor, hint = true)
        assertEquals(BarSide.TOP, withHint.side)
        assertNotNull(withHint.hintTop)
        assertEquals("hint below the top bar", true, withHint.hintTop!! >= withHint.step.bottom)
        val bottom = commandBarPlacement(w, h, d, none, listOf(info, primary), anchor = null, hint = true)
        assertEquals("hint 38 dp above the shelf", dp(752f - 38f), bottom.hintTop)
        assertEquals(bottom.hintTop, bottom.footprint.top)
    }

    @Test fun `when no side can clear a huge building the smaller overlap wins and the caller is told`() {
        val anchor = PxRect(0f, dp(100f), w, dp(800f)) // the bottom band hides 48 dp of it, the top band about 180 dp
        val p = commandBarPlacement(w, h, d, none, listOf(info, primary), anchor, hint = false)
        assertTrue(p.coversAnchor)
        assertEquals(BarSide.BOTTOM, p.side)
        val sticky = commandBarPlacement(w, h, d, none, listOf(info, primary), anchor, hint = false, previous = BarSide.TOP)
        assertEquals("a smaller overlap beats stickiness", BarSide.BOTTOM, sticky.side)
    }

    @Test fun `the bar keeps its side while the camera pans as long as that side still clears the building`() {
        val mid = sprite(160f, 420f)
        assertEquals(BarSide.BOTTOM, commandBarPlacement(w, h, d, none, listOf(info, primary), mid, hint = false).side)
        assertEquals(BarSide.TOP, commandBarPlacement(w, h, d, none, listOf(info, primary), mid, hint = false, previous = BarSide.TOP).side)
        val covered = sprite(160f, 160f) // overlaps the top band: a sticky TOP must give way
        assertEquals(BarSide.BOTTOM, commandBarPlacement(w, h, d, none, listOf(info, primary), covered, hint = false, previous = BarSide.TOP).side)
    }

    @Test fun `five commands on a 412 dp phone drop the right-most secondary but never INFO or the primary`() {
        val five = listOf(info, CommandSlotSpec(false, false), CommandSlotSpec(false, true), CommandSlotSpec(false, false), primary)
        val p = commandBarPlacement(w, h, d, none, five, anchor = null, hint = false)
        assertEquals(listOf(3), p.dropped)
        assertEquals(listOf(0, 1, 2, 4), p.slots.map { it.index })
        assertNoOverlap(p)
        val wide = commandBarPlacement(dp(915f), dp(412f), d, none, five, anchor = null, hint = false)
        assertTrue("a landscape screen fits all five", wide.dropped.isEmpty())
        assertNoOverlap(wide)
    }

    @Test fun `a narrow screen first closes the pitch, then drops, and the primary keeps its corner`() {
        val four = listOf(info, CommandSlotSpec(false, false), CommandSlotSpec(false, false), primary)
        val p = commandBarPlacement(dp(360f), h, d, none, four, anchor = null, hint = false)
        assertEquals(dp(360f - 136f), p.slots.last().button.left)
        assertNoOverlap(p)
        p.slots.zipWithNext().filter { !it.second.let { s -> s.button.width > dp(68f) } }.forEach { (x, y) ->
            assertTrue("pitch never under 72 dp", y.button.left - x.button.left >= dp(72f) - 0.01f)
        }
        assertEquals(0, p.slots.first().index)
    }

    @Test fun `a bar without a primary lays its commands out from the left at the full pitch`() {
        val p = commandBarPlacement(w, h, d, none, listOf(info, info, info), anchor = null, hint = false)
        assertEquals(listOf(dp(16f), dp(104f), dp(192f)), p.slots.map { it.button.left })
        assertTrue(p.dropped.isEmpty())
    }

    @Test fun `no command is ever placed off screen and a clear building is never covered`() {
        val specs = listOf(info, upgrade, CommandSlotSpec(false, true), CommandSlotSpec(true, true))
        for (density in listOf(1f, 2f, 2.625f)) for ((wDp, hDp) in listOf(320f to 640f, 360f to 780f, 412f to 915f, 480f to 1000f, 915f to 412f, 1280f to 800f))
            for (insets in listOf(PxInsets(), PxInsets(left = 0f, top = 24f * density, right = 0f, bottom = 48f * density), PxInsets(left = 44f * density, right = 44f * density, bottom = 21f * density)))
                for (anchorTop in listOf(null, 60f, 300f, hDp / 2f, hDp - 120f)) for (hint in listOf(false, true)) {
                    val sw = wDp * density; val sh = hDp * density
                    val anchor = anchorTop?.let { PxRect(sw / 2f - 42f * density, it * density, sw / 2f + 42f * density, (it + 84f) * density) }
                    val p = commandBarPlacement(sw, sh, density, insets, specs, anchor, hint)
                    val screen = PxRect(insets.left, insets.top, sw - insets.right, sh - insets.bottom)
                    p.slots.forEach { assertTrue("$wDp x $hDp @$density $insets: $it on screen", it.column.within(screen)) }
                    assertTrue("the primary always survives", p.slots.any { specs[it.index].primary })
                    assertTrue("INFO always survives", p.slots.any { it.index == 0 })
                    assertNoOverlap(p)
                    if (anchor != null && !p.coversAnchor) assertFalse(p.footprint.intersects(anchor))
                }
    }

    // ---- Name plate ----

    private val plateW = dp(240f)
    private val plateH = dp(58f)

    @Test fun `the plate floats 16 dp above the roof with a 20 dp stem down to it`() {
        val anchor = sprite(246f, 288f)
        val p = namePlatePlacement(w, h, d, none, anchor, plateW, plateH, avoid = emptyList())
        assertEquals(PlateSide.ABOVE, p.side)
        assertEquals(anchor.top - dp(16f), p.plate.bottom)
        assertEquals(dp(4f), p.stem.width)
        assertEquals(dp(20f), p.stem.height)
        assertTrue(p.stem.top < p.plate.bottom && p.stem.bottom > anchor.top)
        assertTrue("the stem leaves the plate between its corners", p.stem.left >= p.plate.left + dp(8f) && p.stem.right <= p.plate.right - dp(8f))
        assertFalse(p.coversAnchor)
    }

    @Test fun `the plate is clamped 8 dp from both screen edges`() {
        val left = namePlatePlacement(w, h, d, none, sprite(0f, 400f), plateW, plateH, emptyList())
        assertEquals(dp(8f), left.plate.left)
        val right = namePlatePlacement(w, h, d, PxInsets(right = dp(20f)), sprite(380f, 400f, 32f), plateW, plateH, emptyList())
        assertEquals(w - dp(20f) - dp(8f), right.plate.right)
    }

    @Test fun `a plate that would cross the resource stack moves left of it`() {
        val stack = resourceStackRect(w, d)
        val anchor = sprite(300f, 160f, 60f) // plate above would span y 86-144: the stack's rows reach y 118
        val p = namePlatePlacement(w, h, d, none, anchor, plateW, plateH, listOf(stack))
        assertEquals(PlateSide.ABOVE, p.side)
        assertFalse(p.plate.intersects(stack))
        assertEquals(stack.left - dp(8f), p.plate.right)
    }

    @Test fun `a building at the top of the screen gets its plate below the selection ring with the stem pointing up`() {
        val anchor = sprite(160f, 30f)
        val p = namePlatePlacement(w, h, d, none, anchor, plateW, plateH, emptyList())
        assertEquals(PlateSide.BELOW, p.side)
        val ring = selectionRingBottom(anchor, d)
        assertEquals(ring + dp(16f), p.plate.top)
        assertTrue(p.stem.top < ring && p.stem.bottom > p.plate.top)
        assertFalse(p.coversAnchor)
    }

    @Test fun `on a phone the plate and the bar together never cover a selected building or each other`() {
        for (hint in listOf(false, true)) for (x in listOf(0f, 60f, 164f, 300f, 328f)) {
            var y = 40f
            while (y <= 915f - 84f) {
                val anchor = sprite(x, y)
                val bar = commandBarPlacement(w, h, d, none, listOf(info, upgrade, primary), anchor, hint)
                assertFalse("bar over the building at $x,$y hint=$hint", bar.coversAnchor)
                val plate = namePlatePlacement(w, h, d, none, anchor, plateW, plateH, listOf(resourceStackRect(w, d), bar.footprint))
                assertFalse("plate over the building at $x,$y hint=$hint", plate.coversAnchor)
                assertFalse("plate over the bar at $x,$y hint=$hint", plate.plate.intersects(bar.footprint))
                assertTrue("plate on screen at $x,$y", plate.plate.within(PxRect(0f, 0f, w, h)))
                y += 37f
            }
        }
    }

    @Test fun `a reason pill without a hint goes where the hint would, without moving the bar`() {
        val plain = commandBarPlacement(w, h, d, none, listOf(info, primary), anchor = null, hint = false)
        val hinted = commandBarPlacement(w, h, d, none, listOf(info, primary), anchor = null, hint = true)
        assertEquals(hinted.hintTop, plain.pillTop)
        assertEquals(plain.slots, hinted.slots)
    }

    // ---- State line tint: the server's text is shown verbatim, only coloured ----

    @Test fun `the state line tints counts and times like the mock and never changes the words`() {
        val runs = stateLineRuns("Smelted 2/3 · pool 6h 20m")
        assertEquals("Smelted 2/3 · pool 6h 20m", runs.joinToString("") { it.text })
        assertEquals(StateRun("2/3", StateTone.VALUE), runs.first { it.tone == StateTone.VALUE })
        assertEquals(StateRun("6h 20m", StateTone.TIME), runs.first { it.tone == StateTone.TIME })
        assertEquals(StateTone.MUTED, runs.first().tone)
        assertEquals(StateRun("0:42", StateTone.TIME), stateLineRuns("Training 4 · 0:42").last())
        assertEquals(StateRun("Ready", StateTone.READY), stateLineRuns("Ready · 8,400 Shards").first())
        assertEquals(StateRun("Spent", StateTone.DANGER), stateLineRuns("Spent · rearm it").first())
        assertEquals(listOf(StateRun("Trading opens later", StateTone.MUTED)), stateLineRuns("Trading opens later"))
        assertTrue(stateLineRuns("").isEmpty())
        assertEquals("…", stateLineRuns("…").single().text)
    }

    private fun assertNoOverlap(p: CommandBarPlacement) {
        p.slots.sortedBy { it.button.left }.zipWithNext().forEach { (a, b) -> assertTrue("$a overlaps $b", a.button.right <= b.button.left) }
    }
}
