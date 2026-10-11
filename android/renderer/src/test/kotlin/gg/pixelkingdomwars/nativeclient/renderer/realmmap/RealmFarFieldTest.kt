package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The owner's Seeker feedback (2026-09-25): "when you zoom out after you enter realm its like cut picture". The N2 map
 * drew SHELL's `stub-ground`, whose painting ended in a hard rectangle on a fixed navy outside the grid. What these tests
 * protect:
 * - the core's ground is the web's own FAR program `rm-chart`, bound as ground.js `drawChart` binds it: the far field on
 *   unit 5, the painting's ring sea as `uSeaFar`, the screen cleared to that same sea — so the realm sits in its own
 *   sea with a soft coast at every zoom the camera can reach, and the exported stage really fades into `uSeaFar`;
 * - pinching out past the whole-realm fit asks for the globe once, and the leave snapshot is the realm in its sea (the
 *   dive fade reversed, never a black frame);
 * - bases stay visible: `rm-chart` has no occupancy dots, so the core draws the base points until a bases lane does.
 */
class RealmFarFieldTest {
    private val rig = RealmProbeRig()
    private val exits = ArrayList<DoubleArray>()
    private val engine = RealmMapEngine(
        rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
        RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS,
    ).apply {
        listener = object : RealmMapListener { override fun onExit(lon: Double, lat: Double) { exits += doubleArrayOf(lon, lat) } }
        // the 12 × 8 fixture realm fits this screen below FAR, like a real realm on the Seeker (the owner's zoom-out)
        setViewport(240, 520, 2.0)
    }

    private fun frame(allow: Boolean = true, realm: Boolean = true) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin())
        engine.update(rig.nowMs, allow)
        rig.uploads.poll(rig.core)
        if (!realm && allow) engine.rehearseStep(rig.nowMs)
        if (realm) engine.frame(rig.nowMs, rig.nowMs.toLong(), false) else rig.core.beginScreen(0f, 0f, 0f, 1f)
        rig.end()
    }

    private fun readyAndEnter() {
        assertTrue(engine.prepare("alpha"))
        var n = 0
        while (!engine.ready && n < 200) { frame(realm = false); n++ }
        assertTrue(engine.ready)
        val g = assertNotNull(engine.grid)
        assertTrue(engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        engine.setMinimapRect(12.0, 180.0, 60.0, 40.0)
    }

    private fun ringSea(): FloatArray {
        val bytes = assertNotNull(RealmTestData.resource("/world/fixtures/packs/overview/realm/alpha/chart8.png"))
        val img = assertNotNull(PNG_DECODER.decode(bytes, "chart8.png"))
        return RealmLoader.ringSea(img)
    }

    /** The fake name of the realm's far field (R8, one texel per deed). */
    private fun farName(): Int {
        val g = engine.grid!!
        return rig.group.textures.indexOfFirst { it != null && it.internalFormat == GL30.GL_R8 && it.width == g.cols && it.height == g.rows }
    }

    private fun screenDraws(from: Int) = rig.gl.draws.subList(from, rig.gl.draws.size).filter { it.framebuffer == 0 }

    @Test fun `the core's ground is the web's rm-chart in the realm's own sea, bound like ground drawChart, never stub-ground`() {
        readyAndEnter()
        val chart = engine.programs!!.overview
        assertEquals("rm-chart", chart.name)
        assertFalse(RealmPrograms.RETIRED_STUB in RealmPrograms.EXPORTED, "the hard-cut stand-in is never loaded")
        assertTrue(engine.programs!!.all.none { it.name == RealmPrograms.RETIRED_STUB })
        val before = rig.gl.draws.size; val clears = rig.gl.clears.size
        frame()
        val first = screenDraws(before).first()
        assertEquals(chart.handle, first.program, "the screen pass starts with the chart (a full-screen triangle: it covers every px)")
        val sea = ringSea()
        assertContentEquals(sea, first.vec3, "uSeaFar is the painting's own ring sea (ground.js palette().seaFar)")
        assertEquals(farName(), first.units[RealmChart.UNIT_FAR], "the far field is on ground.js's unit 5")
        assertContentEquals(floatArrayOf(sea[0], sea[1], sea[2], 1f), rig.gl.clears.subList(clears, rig.gl.clears.size).last(),
            "the screen is cleared to the realm's sea, never the fixed navy")
        val out = FloatArray(3); engine.seaColour(out); assertContentEquals(sea, out)
    }

    @Test fun `the exported rm-chart fades the painting into uSeaFar beyond the grid, the frame and the foreign cut`() {
        val fs = WorldShaders.source(WorldShaders.realm.getValue("rm-chart").fs)
        val main = fs.substring(fs.indexOf("void main()"))
        assertTrue(main.contains("greaterThanEqual(p, g))) { o = vec4(uSeaFar"), "outside the grid: the open sea, not a fixed colour")
        assertTrue(main.contains("col = mix(uSeaFar, col, rmKeep(p, g, seaLike(col)));"), "inside: the painting eases into the sea")
        assertTrue(fs.contains("float rmKeep(vec2 p, vec2 g, float sea)") && fs.contains("rmForeignCut(p)"), "the GA2-04 foreign cut and frame fade")
        val stub = WorldShaders.source(WorldShaders.realm.getValue("stub-ground").fs)
        assertTrue(stub.contains("o = vec4(0.05, 0.13, 0.27, 1.0); return;"), "the retired stand-in is the hard navy cut this replaces")
    }

    @Test fun `at every zoom and pan the camera can reach, the whole screen is the realm's ground in its own sea`() {
        readyAndEnter()
        val chart = engine.programs!!.overview; val sea = ringSea(); val g = engine.grid!!
        val cam = engine.cam
        // pinch out to the gesture floor (0.6 × fit) without crossing the exit, then pan to every corner and edge of the grid
        val targets = listOf(0.0 to 0.0, g.cols.toDouble() to 0.0, 0.0 to g.rows.toDouble(), g.cols.toDouble() to g.rows.toDouble(), g.cols / 2.0 to g.rows / 2.0)
        for ((tx, ty) in targets) for (s in doubleArrayOf(cam.sMin() * 0.72, cam.sMin(), cam.sMin() * 2.2)) {
            cam.set(tx, ty, s)
            assertTrue(cam.x in 0.0..g.cols.toDouble() && cam.y in 0.0..g.rows.toDouble(), "the web's clamp keeps the centre on the grid")
            val before = rig.gl.draws.size; val clears = rig.gl.clears.size
            frame()
            val draws = screenDraws(before)
            assertEquals(chart.handle, draws.first().program, "view ($tx, $ty) s $s: the chart covers the screen")
            assertContentEquals(sea, draws.first().vec3)
            assertContentEquals(floatArrayOf(sea[0], sea[1], sea[2], 1f), rig.gl.clears.subList(clears, rig.gl.clears.size).last())
        }
        assertTrue(exits.isEmpty(), "placing the camera is not a pinch-out")
    }

    @Test fun `a pinch below 0·7 × the fit asks for the globe once, from the camera centre, and the leave snapshot is the realm in its sea`() {
        readyAndEnter()
        val cam = engine.cam; val g = engine.grid!!
        val fit = cam.sMin()
        var t = rig.nowMs
        engine.touchDown(1, 60.0, 80.0, t); engine.touchDown(2, 180.0, 180.0, t)
        var a = 60.0; var b = 180.0
        while (cam.s >= fit * 0.7 && a < 119.0) { a += 6.0; b -= 6.0; t += 16.0; engine.touchMove(1, a, a + 20, t); engine.touchMove(2, b, b, t); frame() }
        assertTrue(cam.s < fit * 0.7, "pinched below 0.7 × fit: ${cam.s / fit}")
        assertEquals(1, exits.size, "one exit request")
        assertEquals(g.lonAt(cam.x), exits[0][0], 1e-3); assertEquals(g.latAt(cam.y), exits[0][1], 1e-3)
        repeat(4) { t += 16.0; engine.touchMove(1, a + 1, a + 21, t); frame() }
        assertEquals(1, exits.size, "further moves never ask again: the host's leave is in flight")
        assertEquals(1, engine.stats.exitRequests)
        engine.touchUp(1, a, a, t); engine.touchUp(2, b, b, t)
        // the host's leave: this frame into the snapshot, then faded out over the globe (the dive fade reversed)
        rig.nowMs += 16.667; check(rig.begin()); engine.update(rig.nowMs, false)
        val before = rig.gl.draws.size
        assertTrue(engine.renderSnapshot(rig.nowMs.toLong(), false))
        engine.leave(rig.nowMs)
        rig.core.beginScreen(0f, 0f, 0f, 1f); engine.fade.start(RealmDiveFade.LEAVE, rig.nowMs); engine.compositeFade(rig.nowMs); rig.end()
        val snap = rig.gl.draws.subList(before, rig.gl.draws.size)
        assertEquals(engine.programs!!.overview.handle, snap.first { it.framebuffer != 0 }.program, "the snapshot is the realm's chart, not a black frame")
        assertEquals(1.0, engine.fade.realmAlpha(rig.nowMs), "the leave starts fully on the realm")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
        // a new visit may leave again
        engine.fade.finish(); frame(realm = false)
        assertTrue(engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        engine.onPinchOut()
        assertEquals(2, exits.size)
    }

    @Test fun `GROUND's chart under MAP is this same rm-chart in the realm's sea, with GROUND's coast field once resident`() {
        // Lead integration (NR `GroundLane.chartUnder`): ground.js draws `drawChart` under MAP in the FAR→MAP fade and while
        // the view's lattice resolves. Without it MAP pops in at the fade's end; with a second chart implementation the
        // zoom-in would show a different sea or coast than the zoomed-out realm (the owner's "cut picture" again).
        assertFalse(engine.drawChartUnder(null, 1.0), "nothing to draw before the realm's first-frame set is adopted")
        readyAndEnter()
        frame()
        val chart = engine.programs!!.overview; val sea = ringSea()
        val neutral = screenDraws(0).last { it.program == chart.handle }.units[RealmChart.UNIT_FIELDS_A]
        val fieldsA = assertNotNull(rig.uploads.fresh(rig.core, Gl3Pool.REALM, 4, 4, Gl3Format.RGBA8, 1, Gl3Sampling.LINEAR, Gl3Wrap.CLAMP) { _, _, _, out ->
            while (out.hasRemaining()) out.put(64) })
        val pending = assertNotNull(rig.uploads.fresh(rig.core, Gl3Pool.REALM, 4, 4, Gl3Format.RGBA8, 1, Gl3Sampling.LINEAR, Gl3Wrap.CLAMP) { _, _, _, out ->
            while (out.hasRemaining()) out.put(64) })
        frame() // polls the uploads: both are resident now
        rig.nowMs += 16.667; check(rig.begin()); rig.core.beginScreen(0f, 0f, 0f, 1f)
        val before = rig.gl.draws.size
        assertTrue(engine.drawChartUnder(null, 1.0))
        assertTrue(engine.drawChartUnder(fieldsA, 0.5))
        rig.core.free(pending)
        assertTrue(engine.drawChartUnder(pending, 1.0), "a freed (not ready) coast field falls back to the neutral texel")
        rig.end()
        val under = rig.gl.draws.subList(before, rig.gl.draws.size)
        assertEquals(3, under.size)
        for (d in under) {
            assertEquals(chart.handle, d.program, "the core's rm-chart (one implementation of the bindings)")
            assertContentEquals(sea, d.vec3, "the same ring sea as the zoomed-out realm")
            assertEquals(farName(), d.units[RealmChart.UNIT_FAR])
        }
        assertEquals(neutral, under[0].units[RealmChart.UNIT_FIELDS_A], "no fieldsA yet: the core's neutral coast (no glints)")
        assertEquals(fieldsA.name, under[1].units[RealmChart.UNIT_FIELDS_A], "GROUND's resident fieldsA replaces it")
        assertEquals(neutral, under[2].units[RealmChart.UNIT_FIELDS_A])
        assertFalse(under[0].blend, "opaque as the bottom layer"); assertTrue(under[1].blend, "blended under a band fade")
    }

    @Test fun `the base points stay on the main view until a bases lane draws them`() {
        readyAndEnter()
        val g = engine.grid!!
        val xs = ArrayList<Int>(); val ys = ArrayList<Int>()
        for (dy in 0 until g.rows) for (dx in 0 until g.cols) if ((engine.deeds[dy * g.cols + dx].toInt() and 0xff) == 255 && (dx + dy) % 2 == 0) { xs += dx; ys += dy }
        val tiles = IntArray(xs.size) { g.tileId(xs[it], ys[it]) }
        engine.setBases(WorldBases(3, "alpha", IntArray(xs.size) { tiles[it] % RealmGrid.LATTICE_W }, IntArray(xs.size) { tiles[it] / RealmGrid.LATTICE_W },
            IntArray(xs.size) { 1 + it % 20 }, IntArray(xs.size) { RealmBases.FLAG_OCCUPIED or (if (it == 0) RealmBases.FLAG_MINE else 0) }))
        frame()
        val dots = engine.programs!!.dots.handle
        val before = rig.fake.draws.size
        frame()
        val mainDots = rig.fake.draws.subList(before, rig.fake.draws.size).filter { it.program == dots && it.framebuffer == 0 && !it.scissor }
        assertEquals(1, mainDots.size, "one unscissored dots pass over the whole view")
        assertEquals(xs.size, mainDots[0].instances, "every base (the selection adds one)")
        assertTrue(engine.stats.occupancyDots)
    }
}
