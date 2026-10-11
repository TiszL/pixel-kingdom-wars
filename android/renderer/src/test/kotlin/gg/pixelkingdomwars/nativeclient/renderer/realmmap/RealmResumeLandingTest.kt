package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundStats
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import org.junit.Test
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The engine side of the lock-screen resume (owner, Seeker code 31, after unlock: "Same map, same spot"). The app's new
 * host dives straight back into the realm and lands the player's map on a fresh engine (WorldEngineHost.landResume):
 * the chip, then the card's deed selected, then the old camera placed with `cam.set`. This pins the engine behaviour that
 * order relies on, on a real engine:
 * - a select made BEFORE the placement leaves the placed camera exactly where the player left it, with nothing flying,
 *   at a card below SELECT_D (d 96, the owner's zoomed-in Sunscar map) and at TRUE on a camera panned off the deed;
 * - a select made AFTER the landing (what the HUD's Dived used to send) always flies: to d 700 from below it, a re-centre
 *   on the deed above it. That was the automatic zoom-in D-177 rejected, right after the player unlocked the phone;
 * - the landing's selection survives the new engine's first bases (it has none yet: the HUD sends them once the map is
 *   up), becoming the kingdom on that deed, and the chip is the engine's filter from the first frame.
 */
class RealmResumeLandingTest {
    private val rig = RealmGlRig()
    private val sources = RealmPrograms.load()

    private fun engine(): RealmMapEngine {
        val lane = FakeLane(rig.core, "detail", listOf("rm-map", "rm-true")).apply { createOnOpen = sources }
        return RealmMapEngine(
            rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
            RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS,
            shaderSources = { sources }, lanes = listOf(lane),
        ).apply { setViewport(240, 520, 2.0) }
    }

    private fun globeFrame(e: RealmMapEngine) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core); e.rehearseStep(rig.nowMs)
        rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end()
    }

    private fun realmFrame(e: RealmMapEngine) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core)
        if (e.waiting) e.rehearseStep(rig.nowMs)
        e.frame(rig.nowMs, rig.nowMs.toLong(), false)
        rig.end()
    }

    /** A new engine's dive into the fixture realm, as the host's diveStep: prepare, rehearse until ready, enter. The card's
     *  deed is the realm-deed nearest the centre. */
    private class Entered(val e: RealmMapEngine, val dx: Int, val dy: Int, val catalogX: Int, val catalogY: Int)
    private fun entered(): Entered {
        val e = engine()
        assertTrue(e.prepare("alpha"))
        var n = 0; while (!e.ready && n < 1000) { globeFrame(e); n++ }
        assertTrue(e.ready)
        val g = e.grid!!
        assertTrue(e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        var best: IntArray? = null
        for (y in 0 until g.rows) for (x in 0 until g.cols) if ((e.deeds[y * g.cols + x].toInt() and 0xff) == 255) {
            val c = intArrayOf(x, y)
            if (best == null || abs(x + 0.5 - g.cols / 2.0) + abs(y + 0.5 - g.rows / 2.0) < abs(best[0] + 0.5 - g.cols / 2.0) + abs(best[1] + 0.5 - g.rows / 2.0)) best = c
        }
        val (dx, dy) = best!!.let { it[0] to it[1] }
        val tile = g.tileId(dx, dy)
        return Entered(e, dx, dy, tile % RealmGrid.LATTICE_W, tile / RealmGrid.LATTICE_W)
    }

    private val mine = WorldFilter(WorldFilterKind.MINE)

    /** WorldEngineHost.landResume's order on this engine: the chip, the card's deed, then the old camera (d in device px). */
    private fun land(l: Entered, x: Double, y: Double, d: Double) {
        l.e.setFilter(mine)
        l.e.selectCatalogDeed(l.catalogX, l.catalogY, fly = false)
        l.e.cam.set(x, y, d / 2.0)
    }

    private fun assertAt(e: RealmMapEngine, x: Double, y: Double, d: Double, why: String) {
        assertEquals(x, e.cam.x, 1e-9, "$why: x"); assertEquals(y, e.cam.y, 1e-9, "$why: y"); assertEquals(d, e.cam.d, 1e-9, "$why: d")
        assertFalse(e.cam.moving, "$why: nothing flies")
    }

    @Test fun `a selection landed before the camera leaves the camera where the player left it, below SELECT_D and panned at TRUE`() {
        assertTrue(96.0 < RealmWebPin.BANDS.selectD, "d 96 is below SELECT_D: the case where a select zooms in")
        for ((name, at) in listOf("the owner's d 96 card" to { l: Entered -> doubleArrayOf(l.dx + 0.5, l.dy + 0.5, 96.0) },
            "a TRUE camera panned off the deed" to { l: Entered -> doubleArrayOf(l.dx + 0.5 + 0.13, l.dy + 0.5 - 0.09, 1400.0) })) {
            val l = entered(); val e = l.e; val (x, y, d) = at(l).let { Triple(it[0], it[1], it[2]) }
            land(l, x, y, d)
            assertAt(e, x, y, d, "$name, landed")
            assertEquals(l.dx, e.bases.selectedFreeX, "$name: the card's deed is selected"); assertEquals(l.dy, e.bases.selectedFreeY)
            assertEquals(WorldFilterKind.MINE, e.bases.filter.kind, "$name: the chip is the engine's filter")
            repeat(60) { realmFrame(e) } // 1 s: longer than the select's 700 ms flight
            assertAt(e, x, y, d, "$name, a second later")
            assertEquals(l.dx, e.bases.selectedFreeX, "$name: still selected")
        }
    }

    @Test fun `a select after the landing flies off the spot - what the resume used to send at Dived`() {
        val low = entered()
        low.e.cam.set(low.dx + 0.5, low.dy + 0.5, 96.0 / 2.0)
        low.e.selectCatalogDeed(low.catalogX, low.catalogY, fly = false)
        assertTrue(low.e.cam.moving, "a select below SELECT_D flies")
        repeat(60) { realmFrame(low.e) }
        assertEquals(RealmWebPin.BANDS.selectD, low.e.cam.d, 1.0, "the automatic zoom-in to SELECT_D (D-177 rejected it)")

        val high = entered(); val x = high.dx + 0.5 + 0.13; val y = high.dy + 0.5 - 0.09
        high.e.cam.set(x, y, 1400.0 / 2.0)
        high.e.selectCatalogDeed(high.catalogX, high.catalogY, fly = false)
        assertTrue(high.e.cam.moving, "a select above SELECT_D re-centres")
        repeat(60) { realmFrame(high.e) }
        assertTrue(abs(high.e.cam.x - x) > 0.05 || abs(high.e.cam.y - y) > 0.05, "the panned camera slid back to the deed (${high.e.cam.x}, ${high.e.cam.y})")
    }

    @Test fun `the landing's open-deed selection becomes the kingdom there when the HUD's first bases arrive`() {
        val l = entered(); val e = l.e
        land(l, l.dx + 0.5, l.dy + 0.5, 96.0)
        assertEquals(-1, e.bases.selectedBase, "the new engine has no bases yet: the deed reads as open land")
        e.setBases(WorldBases(1, "alpha", intArrayOf(l.catalogX), intArrayOf(l.catalogY), intArrayOf(3),
            intArrayOf(RealmBases.FLAG_OCCUPIED or RealmBases.FLAG_MINE)))
        assertEquals(e.bases.baseAt(l.dx, l.dy), e.bases.selectedBase, "the card's kingdom is the selection")
        assertTrue(e.bases.selectedBase >= 0)
        assertEquals(WorldFilterKind.MINE, e.bases.filter.kind, "the chip holds across the bases")
        assertAt(e, l.dx + 0.5, l.dy + 0.5, 96.0, "the bases move nothing")
    }

    // ---------------------------------------------------------------- the landing under clouds (RealmResumeLanding)

    private fun ground(status: String = "ready", map: Boolean = true, tru: Boolean = false, hasTrue: Boolean = true, missing: Int = 0, pages: Int = 0) =
        GroundStats().apply { this.status = status; mapReady = map; trueReady = tru; this.hasTrue = hasTrue; latticeMissingInView = missing; pagesMissingInView = pages }

    @Test fun `a landing counts as on screen only once the resumed band's own ground drew it`() {
        val chart = RealmEngineConfig.PASS_CHART; val fade = RealmEngineConfig.PASS_NONE
        val map = RealmEngineConfig.PASS_MAP; val tru = RealmEngineConfig.PASS_TRUE
        fun landed(band: Int, pass: Int, g: GroundStats?) = RealmResumeLanding.landed(band, pass, g)
        // the owner's rejected look: the core's chart at MAP (other realms' deeds veiled per deed, hard-edged grey squares)
        assertFalse(landed(RealmBand.MAP, chart, ground(status = "loading", map = false)), "GROUND still loading: the chart stands in")
        assertFalse(landed(RealmBand.MAP, chart, ground()), "MAP data in but its pairs not rehearsed (the lane held): still the chart")
        assertFalse(landed(RealmBand.MAP, fade, ground(missing = 3)), "MAP drawn over an unresolved lattice: the chart shows through, then pops")
        assertTrue(landed(RealmBand.MAP, map, ground()), "MAP alone over a resolved lattice: the real map")
        assertTrue(landed(RealmBand.FAR_MAP, fade, ground()), "FAR→MAP: the chart's share of the crossfade is the band's own")
        // a TRUE camera (the player's own base at MY_BASE_D)
        assertFalse(landed(RealmBand.TRUE, map, ground()), "MAP standing in for TRUE, which then pops in")
        assertFalse(landed(RealmBand.MAP_TRUE, fade, ground()), "the MAP→TRUE fade without TRUE yet")
        assertFalse(landed(RealmBand.TRUE, tru, ground(tru = true, pages = 1)), "TRUE with a page of the view missing (MAP under it)")
        assertTrue(landed(RealmBand.TRUE, tru, ground(tru = true)), "TRUE with every page")
        assertTrue(landed(RealmBand.TRUE, map, ground(hasTrue = false)), "a realm without TRUE ground: MAP is its picture there")
        // nothing better is coming: never hold the clouds for it
        assertTrue(landed(RealmBand.FAR, chart, ground(status = "loading", map = false)), "FAR: the chart is the picture")
        assertTrue(landed(RealmBand.MAP, chart, null), "no detail pack (or GROUND disabled): the chart is all this realm draws")
        assertTrue(landed(RealmBand.MAP, chart, ground(status = "failed", map = false)), "GROUND failed")
    }

    @Test fun `every step a landing waits on moves its progress, so the stall rule never cuts a landing that still loads`() {
        val st = RealmMapStats(); val g = ground(status = "loading", map = false)
        val seen = arrayListOf(RealmResumeLanding.progress(st, g))
        fun step(what: String, change: () -> Unit) {
            change(); val p = RealmResumeLanding.progress(st, g)
            assertTrue(p > seen.last(), "$what moves the progress: ${seen.last()} -> $p"); seen += p
        }
        step("GROUND opened") { st.lanesOpened = 1 }
        step("GROUND's load in") { g.status = "ready" }
        step("its MAP data resident") { g.mapReady = true }
        step("a lane pair rehearsed") { st.lanePairsRehearsed = 1 }
        step("a lattice sub-tile resolved") { g.latticeResolved = 1 }
        step("TRUE resident") { g.trueReady = true }
        step("a TRUE page resolved") { g.pagesResolved = 1 }
        step("LIFE opened") { st.lanesOpened = 3 }
        assertEquals(seen.last(), RealmResumeLanding.progress(st, null) + 5.0, "without GROUND only the engine's lane counts")
    }

    /** The host's resume on the real engine and its three real lanes over the stage-B bundle: prepare with lanes (the
     *  resume's beginDive), the core's wait, the entry, the old camera placed; then realm frames until the landing rule
     *  says the ground is on screen. Returns the frames it took. */
    private fun landing(w: RealWorld, realm: String, d: Double, firstFrame: (RealWorld) -> Unit): Int {
        assertTrue(w.engine.prepare(realm))
        var n = 0
        while (!w.engine.ready && n < 4000) { w.globeFrame(); n++ }
        assertTrue(w.engine.ready, "$realm dive-ready")
        val g = w.engine.grid!!
        assertTrue(w.engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        w.engine.cam.set(g.cols / 2.0, g.rows / 2.0, d / 2.0) // WorldEngineHost.placeResume at the Seeker's dpr 2
        w.realmFrame(); firstFrame(w)
        n = 1
        while (!RealmResumeLanding.landed(w.engine.stats.band, w.engine.stats.groundPass, w.ground.stats) && n < 4000) { w.realmFrame(); n++ }
        assertTrue(RealmResumeLanding.landed(w.engine.stats.band, w.engine.stats.groundPass, w.ground.stats),
            "$realm at d $d landed in $n frames (ground ${w.ground.stats.status} map ${w.ground.stats.mapReady} true ${w.ground.stats.trueReady} " +
                "missing ${w.ground.stats.latticeMissingInView}/${w.ground.stats.pagesMissingInView} pass ${w.engine.stats.groundPass})")
        assertEquals(d, w.engine.cam.d, 1e-9, "the saved spot: nothing moved the camera while it waited")
        println("[resume-landing] $realm d ${d.toInt()}: on its ground after $n realm frames (FakeGl3, direct decode)")
        return n
    }

    @Test fun `on the real engine a MAP resume stands on the veiled chart first, and its landed frame draws MAP alone`() {
        // Sunscar at d 96, the owner's lock-screen map (the Crownlands strip is the veiled chart's grey squares)
        val w = RealWorld(DirectExecutor)
        val n = landing(w, "sunscar", 96.0) { first ->
            assertEquals(RealmBand.MAP, first.engine.stats.band, "d 96 is full MAP")
            assertEquals(RealmEngineConfig.PASS_CHART, first.engine.stats.groundPass, "the first frame after the placement is the core's chart: what the clouds must hide")
            assertFalse(RealmResumeLanding.landed(first.engine.stats.band, first.engine.stats.groundPass, first.ground.stats))
        }
        assertTrue(n > 1)
        assertEquals(RealmEngineConfig.PASS_MAP, w.engine.stats.groundPass, "the landed frame: MAP alone")
        assertFalse(w.ground.stats.drawnChart, "no chart anywhere in the landed frame: no grey square is ever seen")
        assertTrue(w.ground.stats.drawnMap)
    }

    @Test fun `on the real engine a TRUE resume waits for TRUE with every page, never MAP standing in`() {
        val w = RealWorld(DirectExecutor)
        landing(w, "sunscar", RealmWebPin.BANDS.myBaseD) { first -> assertEquals(RealmBand.TRUE, first.engine.stats.band) }
        assertTrue(w.ground.stats.hasTrue, "sunscar's pack has TRUE ground")
        assertEquals(RealmEngineConfig.PASS_TRUE, w.engine.stats.groundPass, "the landed frame: TRUE alone")
        assertFalse(w.ground.stats.drawnChart || w.ground.stats.drawnMap, "nothing stands in for TRUE in the landed frame")
    }
}
