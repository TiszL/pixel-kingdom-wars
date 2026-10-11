package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeDraw
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Test
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The selected OPEN deed's box (owner 2026-09-26, choosing land: "could not tell which land deed was selected"; the web's
 * ui.js `deedBox` + `.rmx-selbox`, SHARDKEEP-globe 1d39d2e7 + 36745a38). The landing's chart and TRUE draw no deed
 * selection and MAP only a thin edge, so a tapped or "Next open deed" deed must carry its own mark at every zoom. What
 * each test protects:
 * - the box reads at every zoom: never under 18 CSS px at the landing (deeds are 5–12 px there), the deed itself at MAP,
 *   clipped just past the screen at TRUE (a deed thousands of px wide never becomes a huge pass), and its tint eases from
 *   0.30 to 0.16 as the deed grows, so a screen-filling deed (its border off screen) still reads as selected;
 * - the pulse is the web's CSS breath (1 → 0.6 → 1 over 1.6 s, ease-in-out), and it holds at full strength under
 *   reduced motion (the owner's accessibility rule) and at the idle freeze;
 * - the engine draws it on the screen at the landing, MAP and TRUE for an open deed only (a kingdom keeps its own
 *   selection), rehearsed before the dive (no pipeline build in a live frame), asks for idle frames only while it is on
 *   screen, and is gone the frame after a deselect.
 */
class RealmSelectBoxTest {
    private val rig = RealmGlRig()
    private val sources = RealmPrograms.load()
    private val bands = RealmWebPin.BANDS
    private val out = DoubleArray(5)

    // ---- the web's deedBox, ported (ui.test.mjs 'deedBox', bounds of 36745a38) ----

    @Test fun `the box reads at every zoom - at least 18 px at the landing, the deed at MAP, clipped and lighter at TRUE`() {
        for ((s, w, h) in listOf(Triple(12.0, 1280.0, 800.0), Triple(5.6, 1280.0, 800.0), Triple(2.1, 390.0, 844.0))) { // landing d 24 @2, the fits
            val sx = 600.0 % w
            assertTrue(RealmSelectBox.deedBox(sx, 400.0, s, w, h, out), "s $s: on screen")
            assertTrue(out[2] >= 18 && out[3] >= 18, "s $s: a ${out[2]} × ${out[3]} box is too small to see")
            assertTrue(abs(out[0] + out[2] / 2 - (sx + s / 2)) <= 0.5 && abs(out[1] + out[3] / 2 - (400 + s / 2)) <= 0.5, "s $s: the box is off the deed centre")
            assertEquals(0.30, out[4], 1e-9, "a small deed gets the full tint")
        }
        assertTrue(RealmSelectBox.deedBox(465.0, 225.0, 350.0, 1280.0, 800.0, out)) // MAP d 700 @2 (select()'s SELECT_D)
        assertEquals(listOf(465.0, 225.0, 350.0, 350.0), out.take(4), "at MAP the box is the deed itself")
        assertTrue(out[4] < 0.30 && out[4] > 0.16, "MAP fill ${out[4]}")
        assertTrue(RealmSelectBox.deedBox(-1500.0, -1200.0, 3136.0, 390.0, 844.0, out)) // TRUE close-up on a phone: the deed covers the screen
        assertTrue(out[2] <= 390 + 16 && out[3] <= 844 + 16 && out[0] >= -8 && out[1] >= -8, "TRUE box ${out[2]} × ${out[3]} at ${out[0]}, ${out[1]} is not clipped")
        assertEquals(0.16, out[4], 1e-9, "a screen-filling deed gets the light tint, still visible (0.10 was invisible)")
        assertFalse(RealmSelectBox.deedBox(2000.0, 400.0, 12.0, 1280.0, 800.0, out), "off screen: hidden")
    }

    @Test fun `the tint eases from 0-30 at a 96 px deed down to 0-16 at half the screen and never leaves that range`() {
        var last = 1.0
        var s = 1.0
        while (s < 5000) {
            assertTrue(RealmSelectBox.deedBox(100.0, 100.0, s, 390.0, 844.0, out))
            assertTrue(out[4] >= 0.16 - 1e-12 && out[4] <= 0.30 + 1e-12 && out[4] <= last + 1e-12, "s $s: tint ${out[4]} after $last")
            last = out[4]; s *= 1.25
        }
        RealmSelectBox.deedBox(100.0, 100.0, 96.0, 390.0, 844.0, out); assertEquals(0.30, out[4], 1e-9)
        RealmSelectBox.deedBox(100.0, 100.0, 195.0, 390.0, 844.0, out); assertEquals(0.16, out[4], 1e-9, "half the short side (390 / 2)")
        RealmSelectBox.deedBox(100.0, 100.0, 145.5, 390.0, 844.0, out); assertEquals(0.23, out[4], 1e-9, "linear between them")
    }

    @Test fun `the pulse is the web's CSS breath - full, 60 percent at 800 ms, full again at 1600 ms, eased at both ends`() {
        assertEquals(1.0, RealmSelectBox.pulse(0), 1e-9)
        assertEquals(0.6, RealmSelectBox.pulse(800), 1e-9)
        assertEquals(1.0, RealmSelectBox.pulse(1600), 1e-9)
        assertEquals(RealmSelectBox.pulse(300), RealmSelectBox.pulse(1900), 1e-12, "infinite: every 1.6 s")
        assertEquals(0.8, RealmSelectBox.pulse(400), 1e-6); assertEquals(0.8, RealmSelectBox.pulse(1200), 1e-6)
        // CSS ease-in-out = cubic-bezier(0.42, 0, 0.58, 1): a quarter into the fade it has moved 12.9 % (linear 25 %, smoothstep 15.6 %)
        assertEquals(1 - 0.4 * 0.1291619, RealmSelectBox.pulse(200), 1e-6)
        assertEquals(0.6 + 0.4 * 0.1291619, RealmSelectBox.pulse(1000), 1e-6)
        for (t in 0L..3200L step 20) assertTrue(RealmSelectBox.pulse(t) in 0.6..1.0, "t $t: ${RealmSelectBox.pulse(t)}")
    }

    // ---- the engine ----

    private fun engine(lane: FakeLane): RealmMapEngine = RealmMapEngine(
        rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
        RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS,
        shaderSources = { sources }, lanes = listOf(lane),
    ).apply { setViewport(240, 520, 2.0) } // the 12 × 8 fixture realm fits below FAR, like a real realm (landing deeds ~10 CSS px)

    private fun globeFrame(e: RealmMapEngine) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core); e.rehearseStep(rig.nowMs)
        rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end()
    }

    private fun realmFrame(e: RealmMapEngine, frozen: Boolean = false) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core)
        if (e.waiting) e.rehearseStep(rig.nowMs)
        e.frame(rig.nowMs, rig.nowMs.toLong(), frozen)
        rig.end()
    }

    private fun until(e: RealmMapEngine, done: () -> Boolean) {
        var n = 0
        while (!done() && n < 2000) { realmFrame(e); n++ }
        assertTrue(done(), "condition not reached in $n frames (d ${e.cam.d})")
    }

    /** The select program's draws on the screen in the next realm frame. */
    private fun boxDraws(e: RealmMapEngine, frozen: Boolean = false): List<FakeDraw> {
        val from = rig.gl.draws.size
        realmFrame(e, frozen)
        val select = e.programs!!.select.handle
        return rig.gl.draws.subList(from, rig.gl.draws.size).filter { it.program == select && it.framebuffer == 0 }
    }

    /** A realm entered at its landing, with an open deed ([ox], [oy]) and a kingdom on the deed next to it ([kx], [ky]). */
    private class Landed(val e: RealmMapEngine, val landingS: Double, val ox: Int, val oy: Int, val kx: Int, val ky: Int) {
        fun atLanding(x: Int, y: Int) = e.cam.set(x + 0.5, y + 0.5, landingS, free = true) // (a select flies; the landing is put back)
    }

    private fun landed(): Landed {
        val lane = FakeLane(rig.core, "detail", listOf("rm-map", "rm-true")).apply { createOnOpen = sources }
        val e = engine(lane)
        assertTrue(e.prepare("alpha"))
        var n = 0; while (!e.ready && n < 1000) { globeFrame(e); n++ }
        assertTrue(e.ready)
        val g = e.grid!!
        assertTrue(e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        e.setMinimapRect(12.0, 180.0, 60.0, 40.0)
        val landingS = e.cam.s
        assertTrue(landingS < RealmSelectBox.MIN_CSS, "the landing's deeds are small (s $landingS CSS px): the minimum size matters")
        val open = ArrayList<IntArray>()
        for (dy in 0 until g.rows) for (dx in 0 until g.cols) if ((e.deeds[dy * g.cols + dx].toInt() and 0xff) == 255) open += intArrayOf(dx, dy)
        open.sortBy { abs(it[0] + 0.5 - g.cols / 2.0) + abs(it[1] + 0.5 - g.rows / 2.0) }
        val l = Landed(e, landingS, open[0][0], open[0][1], open[1][0], open[1][1])
        val tile = g.tileId(l.kx, l.ky)
        e.setBases(WorldBases(7, "alpha", intArrayOf(tile % RealmGrid.LATTICE_W), intArrayOf(tile / RealmGrid.LATTICE_W), intArrayOf(3), intArrayOf(RealmBases.FLAG_OCCUPIED)))
        assertEquals(0, e.bases.baseAt(l.kx, l.ky), "the kingdom landed on its deed")
        e.onInput(); realmFrame(e)
        return l
    }

    @Test fun `at the landing an open deed's box is 18 px round its small deed, and a kingdom keeps its own selection`() {
        val l = landed(); val e = l.e
        e.select(0); l.atLanding(l.kx, l.ky)
        assertTrue(boxDraws(e).isEmpty(), "a kingdom draws no open-deed box"); assertFalse(e.stats.selectBox)
        e.select(-1, l.ox, l.oy); l.atLanding(l.ox, l.oy)
        val draws = boxDraws(e)
        assertEquals(1, draws.size, "the landing draws the box once"); assertTrue(e.stats.selectBox)
        assertEquals(RealmSelectBox.MIN_CSS, e.selectBox.w); assertEquals(RealmSelectBox.MIN_CSS, e.selectBox.h)
        assertTrue(draws[0].scissor && draws[0].scissorW == 44 && draws[0].scissorH == 44, "(18 + 2 × 2) CSS px × dpr 2: ${draws[0].scissorW} × ${draws[0].scissorH}")
        assertEquals(e.cam.deedToScreenX(l.ox + 0.5), e.selectBox.x + e.selectBox.w / 2, 0.5, "centred on the deed")
        assertEquals(e.cam.deedToScreenY(l.oy + 0.5), e.selectBox.y + e.selectBox.h / 2, 0.5, "centred on the deed")
        assertEquals(RealmSelectBox.FILL_SMALL, e.selectBox.fill, 1e-9)
        assertEquals(50, e.selectionPeriodMs(), "its pulse asks for idle frames while on screen")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "the box's pipeline was built before the dive, in its real state")
    }

    @Test fun `at MAP the box is the deed itself, and at TRUE it is clipped to the screen with the light tint`() {
        val l = landed(); val e = l.e
        e.select(-1, l.ox, l.oy)
        e.onInput(); e.flyToDeed(l.ox + 0.5, l.oy + 0.5, 96.0) // the player zooms in
        until(e) { !e.cam.moving && e.cam.d >= 96 * 0.999 }
        assertTrue(e.cam.d >= bands.mapStart && e.cam.d < bands.trueStart, "in MAP: d ${e.cam.d}")
        var draws = boxDraws(e)
        assertEquals(1, draws.size, "MAP draws the box")
        assertEquals(e.cam.s, e.selectBox.w, 0.5, "the box is the deed at MAP")
        assertEquals(((e.cam.s + 4) * 2), draws[0].scissorW.toDouble(), 2.0, "MAP scissor: the deed and its ring")
        // TRUE: the deed (hundreds of CSS px) is far larger than the 120 × 260 screen: the box is clipped to it, the tint light
        e.onInput(); e.flyToDeed(l.ox + 0.5, l.oy + 0.5, bands.myBaseD)
        until(e) { !e.cam.moving && e.cam.d > bands.trueStart }
        draws = boxDraws(e)
        assertEquals(1, draws.size, "TRUE draws the box")
        assertTrue(draws[0].scissorW == 240 && draws[0].scissorH == 520, "clipped to the target: ${draws[0].scissorW} × ${draws[0].scissorH}")
        assertTrue(e.selectBox.w <= 120 + 16 && e.selectBox.h <= 260 + 16, "never a huge box: ${e.selectBox.w} × ${e.selectBox.h}")
        assertEquals(RealmSelectBox.FILL_LARGE, e.selectBox.fill, 1e-9)
        assertEquals(0L, rig.core.stats.liveFirstDraws)
    }

    @Test fun `the box breathes with the clock and holds at full strength under reduced motion and the idle freeze`() {
        val l = landed(); val e = l.e
        e.select(-1, l.ox, l.oy); l.atLanding(l.ox, l.oy)
        val alphas = HashSet<Double>()
        repeat(100) { assertEquals(1, boxDraws(e).size); alphas += e.selectBox.alpha } // one full 1.6 s breath
        assertTrue(alphas.size > 10 && alphas.minOrNull()!! < 0.65, "the box breathes: ${alphas.minOrNull()}")
        e.reducedMotion = true
        repeat(48) { assertEquals(1, boxDraws(e).size, "reduced motion keeps the box"); assertEquals(1.0, e.selectBox.alpha, "reduced motion: no pulse") }
        e.reducedMotion = false
        repeat(48) { assertEquals(1, boxDraws(e, frozen = true).size); assertEquals(1.0, e.selectBox.alpha, "the idle freeze: full strength") }
    }

    /** A server snapshot (CATALOG columns/rows, like the HUD's feed) with a level-3 kingdom on each LOCAL deed. */
    private fun kingdoms(e: RealmMapEngine, epoch: Long, vararg deeds: Pair<Int, Int>): WorldBases {
        val g = e.grid!!
        val tiles = deeds.map { (x, y) -> g.tileId(x, y) }
        return WorldBases(epoch, "alpha", IntArray(tiles.size) { tiles[it] % RealmGrid.LATTICE_W }, IntArray(tiles.size) { tiles[it] / RealmGrid.LATTICE_W },
            IntArray(tiles.size) { 3 }, IntArray(tiles.size) { RealmBases.FLAG_OCCUPIED })
    }

    /**
     * The realm feed is windowed (WorldViewModel.realmWindow): a kingdom chosen from search, Rivals or a jump, or tapped at
     * the landing, may not have its marker loaded yet, so selectDeed finds no base and the catalog calls its deed open.
     * When the window that holds it arrives, the selection must become that kingdom: otherwise the gold "open land" box
     * keeps pulsing on a rival's kingdom (the card says kingdom X, the map says buyable land) and the kingdom's own
     * selection look, minimap dot and lanes never follow. The web draws the box only while `api.selected.free` is set.
     */
    @Test fun `an open deed whose kingdom arrives with the next feed window becomes that kingdom's selection and loses the box`() {
        val l = landed(); val e = l.e; val g = e.grid!!
        val heard = ArrayList<List<Int>>()
        e.listener = object : RealmMapListener {
            override fun onSelection(base: Int, deedX: Int, deedY: Int, tileId: Int) { heard += listOf(base, deedX, deedY, tileId) }
        }
        e.selectDeed(l.ox, l.oy, fly = false); l.atLanding(l.ox, l.oy) // its marker is not in this window yet
        assertEquals(l.ox, e.bases.selectedFreeX, "no marker yet: the deed reads as open")
        assertEquals(1, boxDraws(e).size)
        e.setBases(kingdoms(e, 8, l.kx to l.ky)) // a window without it: still an open deed, the box stays
        assertEquals(l.ox, e.bases.selectedFreeX, "a window that does not hold the deed keeps the open selection")
        assertEquals(1, boxDraws(e).size, "a window that does not hold the deed keeps the box")
        heard.clear()
        e.setBases(kingdoms(e, 9, l.kx to l.ky, l.ox to l.oy)) // the flight settles; the window holds the kingdom
        val b = e.bases.baseAt(l.ox, l.oy)
        assertTrue(b >= 0, "the kingdom landed on the selected deed")
        assertEquals(b, e.bases.selectedBase, "the selection is the kingdom now")
        assertEquals(-1, e.bases.selectedFreeX, "no open deed stays selected under a kingdom"); assertEquals(-1, e.bases.selectedFreeY)
        assertTrue(boxDraws(e).isEmpty(), "no open-land box on a kingdom"); assertFalse(e.stats.selectBox)
        val occ = ByteArray(g.size); e.bases.occupancy(occ)
        assertEquals(4, occ[l.oy * g.cols + l.ox].toInt() and 4, "the kingdom's own selection look (occupancy bit 4)")
        assertEquals(listOf(listOf(b, l.ox, l.oy, g.tileId(l.ox, l.oy))), heard, "the listener hears the kingdom once")
        e.setBases(kingdoms(e, 10, l.kx to l.ky, l.ox to l.oy))
        assertEquals(1, heard.size, "a later window with the same selection is not a new selection")
    }

    @Test fun `a deselect removes the box the next frame and stops its idle frames`() {
        val l = landed(); val e = l.e
        e.select(-1, l.ox, l.oy); l.atLanding(l.ox, l.oy)
        assertEquals(1, boxDraws(e).size); assertEquals(50, e.selectionPeriodMs())
        e.select(-1)
        assertTrue(boxDraws(e).isEmpty(), "no box after a deselect"); assertFalse(e.stats.selectBox)
        assertEquals(0, e.selectionPeriodMs())
    }
}
