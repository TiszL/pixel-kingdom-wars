package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.world.InputScale
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Touch on the realm map (camera.js `bindGestures`) through the native input path (GLOBE-NATIVE-PLAN §3.7): libGDX
 * reports VIEW px, the world surface is a fixed dpr-2 BUFFER, the engine works in CSS px (buffer px ÷ dpr). The traces
 * run at a non-1 view/buffer ratio, so a conversion that is skipped or applied twice moves the map under the finger by
 * the wrong amount (the bug the plan names), and a slop or a tap tested in the wrong unit misfires.
 */
class RealmGesturesTest {
    private val rules = RealmBandRules(RealmWebPin.BANDS, RealmWebPin.DEED_ART)
    private var clock = 0.0
    private val cam = RealmCamera(rules) { clock }.apply { setViewport(457.0, 1017.0, 2.0); setGrid(178, 131); set(89.0, 65.5, 20.0 / 2.0) }
    private val taps = ArrayList<DoubleArray>()
    private var exits = 0
    private val gestures = RealmGestures(cam, object : RealmGestureListener {
        override fun onTap(sx: Double, sy: Double) { taps += doubleArrayOf(sx, sy) }
        override fun onInput() {}
        override fun onPinchOut() { exits++ }
        override fun onChange() {}
    })
    /** A Seeker row with a 1.1487 view/buffer ratio: 1050 × 2336 view px on a 914 × 2034 buffer. */
    private val scale = InputScale().apply { set(1050, 2336, 914, 2034) }
    private fun cssX(viewX: Float) = scale.viewToBufferX(viewX) / 2.0
    private fun cssY(viewY: Float) = scale.viewToBufferY(viewY) / 2.0

    private fun down(id: Int, vx: Float, vy: Float) = gestures.down(id, cssX(vx), cssY(vy), clock)
    private fun move(id: Int, vx: Float, vy: Float) = gestures.move(id, cssX(vx), cssY(vy), clock)
    private fun up(id: Int, vx: Float, vy: Float) = gestures.up(id, cssX(vx), cssY(vy), clock)
    private fun settle() { repeat(200) { clock += 16.667; cam.step(clock) } }

    @Test fun `a pan moves the map exactly under the finger across the view-buffer boundary`() {
        val x0 = cam.x; val y0 = cam.y
        down(1, 500f, 1000f); clock += 16; move(1, 400f, 950f); clock += 16; move(1, 300f, 900f)
        val dxCss = cssX(300f) - cssX(500f); val dyCss = cssY(900f) - cssY(1000f)
        assertEquals(x0 - dxCss / cam.s, cam.x, 1e-9, "x follows the finger in CSS px")
        assertEquals(y0 - dyCss / cam.s, cam.y, 1e-9)
        clock += 200; up(1, 300f, 900f) // released after a pause: no fling
        assertTrue(taps.isEmpty())
    }

    @Test fun `the tap slop is 6 CSS px, not 6 view or buffer px`() {
        // 13 view px = 11.3 buffer px = 5.66 CSS px: still a tap (a slop in view or buffer px would call it a pan)
        assertTrue(cssX(513f) - cssX(500f) < RealmGestures.SLOP)
        down(1, 500f, 1000f); clock += 50; move(1, 513f, 1000f); clock += 50; up(1, 513f, 1000f)
        assertEquals(1, taps.size)
        assertEquals(cssX(513f), taps[0][0], 1e-9)
        clock += 1000
        // 15 view px = 6.53 CSS px: a pan, no tap
        assertTrue(cssX(515f) - cssX(500f) > RealmGestures.SLOP)
        val x0 = cam.x
        down(2, 500f, 1000f); clock += 50; move(2, 515f, 1000f); clock += 50; up(2, 515f, 1000f)
        assertEquals(1, taps.size)
        assertTrue(cam.x != x0)
    }

    @Test fun `a double tap zooms 2_4 about the finger through the rest rule`() {
        val s0 = cam.s
        down(1, 500f, 1000f); clock += 60; up(1, 500f, 1000f)
        clock += 120
        down(1, 500f, 1000f); clock += 60; up(1, 500f, 1000f)
        assertEquals(1, taps.size, "the first tap reports; the second zooms")
        settle()
        val want = rules.restTarget(s0 * 2.4 * 2.0) / 2.0
        assertEquals(want, cam.s, 1e-9)
    }

    @Test fun `a pinch zooms about the fingers' midpoint and a pinch below the fit exits`() {
        val mx = (cssX(400f) + cssX(600f)) / 2; val my = (cssY(1000f) + cssY(1000f)) / 2
        val u0 = cam.screenToDeedX(mx); val v0 = cam.screenToDeedY(my)
        down(1, 400f, 1000f); down(2, 600f, 1000f)
        clock += 16; move(1, 350f, 1000f); move(2, 650f, 1000f)
        assertTrue(cam.s > 10.0)
        assertEquals(u0, cam.screenToDeedX(mx), 1e-6, "the deed under the fingers stays under them")
        assertEquals(v0, cam.screenToDeedY(my), 1e-6)
        // pinch far below the fit: the map asks to leave
        clock += 16; move(1, 495f, 1000f); move(2, 505f, 1000f)
        assertTrue(exits > 0)
        up(2, 505f, 1000f); up(1, 495f, 1000f)
    }

    @Test fun `a set floor is the rest floor - a pinch-out rests back on it and only a pinch-out below 0·7 × it leaves`() {
        // the camera's floor support (camera.js `setFloorD`, D-173). D-NEXT (amends D-173) retired the engine's MAP floor,
        // so the native engine never sets it (RealmMapFloorTest pins that); the camera keeps it because the web's stage-B
        // traces (world/golden/camera.json) set it and must replay unchanged. The web's proportions (undershoot 0.6 ×,
        // exit 0.7 ×) hold measured from a set floor as from the fit
        val floor = RealmWebPin.BANDS.mapStart
        assertTrue(cam.sMin() * 2.0 < RealmWebPin.BANDS.farEnd, "this realm's whole-realm fit is FAR (the old rest)")
        cam.floorD = floor
        cam.set(89.0, 65.5, cam.sRest())
        assertEquals(floor, cam.d, 1e-9)
        // pinch to 0.8 ×, release: back on the floor, no exit
        down(1, 400f, 1000f); down(2, 600f, 1000f)
        clock += 16; move(1, 420f, 1000f); move(2, 580f, 1000f)
        assertEquals(0, exits)
        up(2, 580f, 1000f); up(1, 420f, 1000f); settle()
        assertEquals(floor, cam.d, 1e-9, "the rest rule never leaves the camera below MAP")
        // a flight aimed below the floor (the − button) rests on it
        cam.flyToD(cam.x, cam.y, floor / 2.2, 380.0); settle()
        assertEquals(floor, cam.d, 1e-9)
        // pinch to 0.5 ×: held at the gesture floor (0.6 ×, still above FAR) and it asks to leave
        down(1, 400f, 1000f); down(2, 600f, 1000f)
        clock += 16; move(1, 450f, 1000f); move(2, 550f, 1000f)
        assertTrue(exits > 0, "below 0.7 × the floor: leave")
        assertEquals(0.6 * floor, cam.d, 1e-9); assertTrue(cam.d > RealmWebPin.BANDS.farEnd)
        up(2, 550f, 1000f); up(1, 450f, 1000f); settle()
        // below a raised floor (the dive lands from the globe's scale): a pinch-in neither leaves nor jumps to the floor
        exits = 0
        cam.floorD = 0.0; cam.set(89.0, 65.5, 10.0); cam.floorD = floor
        down(1, 400f, 1000f); down(2, 600f, 1000f)
        clock += 16; move(1, 390f, 1000f); move(2, 610f, 1000f)
        assertEquals(0, exits, "a pinch-in is never a pinch-out")
        assertEquals(20.0 * 220.0 / 200.0, cam.d, 1e-4, "zoomed from where it was (view px through InputScale): no jump to the floor")
        up(2, 610f, 1000f); up(1, 390f, 1000f); settle()
        assertEquals(floor, cam.d, 1e-9, "released: rests on the floor")
        // floor 0 is the pinned web rule: the whole-realm fit
        cam.floorD = 0.0; cam.flyToD(cam.x, cam.y, 1.0, 380.0); settle()
        assertEquals(cam.sMin() * 2.0, cam.d, 1e-9)
    }

    @Test fun `a fling keeps moving from the last 90 ms of samples and then rests`() {
        down(1, 500f, 1000f)
        for (i in 1..6) { clock += 16; move(1, 500f - 30f * i, 1000f) }
        clock += 10; up(1, 320f, 1000f)
        assertTrue(cam.moving)
        val x = cam.x
        clock += 16.667; cam.step(clock)
        assertTrue(cam.x > x, "inertia carries the pan on")
        settle()
        assertTrue(!cam.moving)
    }
}

/** The minimap's own camera, hit helpers and its scissored pass (minimap.js, D-164.6). */
class RealmMinimapTest {
    private val rig = RealmGlRig()
    private val minimap = RealmMinimap(rig.core).apply { setGrid(178, 131); setRect(8.0, 700.0, 132.0, 100.0) }

    @Test fun `at zoom 0 the minimap frames the whole realm with the rect's aspect, and zooming follows the main view`() {
        val r = DoubleArray(4)
        minimap.viewRect(457.0, 1017.0, 10.0, 30.0, 40.0, true, r)
        assertEquals(89.0, (r[0] + r[2]) / 2, 1e-9); assertEquals(65.5, (r[1] + r[3]) / 2, 1e-9)
        assertEquals(132.0 / 100.0, (r[2] - r[0]) / (r[3] - r[1]), 1e-9)
        assertTrue(r[2] - r[0] >= 178.0 && r[3] - r[1] >= 131.0)
        minimap.zoomBy(8.0)
        assertTrue(minimap.zoom > 0.5)
        minimap.viewRect(457.0, 1017.0, 10.0, 30.0, 40.0, true, r)
        assertTrue((r[0] + r[2]) / 2 < 89.0, "the zoomed minimap moves toward the main view")
        minimap.resetZoom(); assertEquals(0.0, minimap.zoom)
    }

    @Test fun `the view box's grab zone is at least 44 CSS px however small the box draws`() {
        minimap.viewRect(457.0, 1017.0, 10.0, 30.0, 40.0, true, minimap.lastRect)
        val dpp = minimap.deedPerPx()
        // a 1-deed box at (30, 40): a finger 18 CSS px beside it still grabs it
        val bx = (30.0 - minimap.lastRect[0]) / dpp; val by = (40.0 - minimap.lastRect[1]) / dpp
        assertTrue(minimap.inBox(bx + 18, by, 30.0, 40.0, 31.0, 41.0))
        assertTrue(!minimap.inBox(bx + 60, by, 30.0, 40.0, 31.0, 41.0))
    }

    @Test fun `the minimap pass is scissored to its rect in device px and restores the viewport`() {
        val core = rig.core
        val p = RealmProgramSet(core, RealmPrograms.load())
        rig.compiler.runAll()
        val chart = core.texture2D(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool.REALM, 64, 48, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format.RGBA8)!!
        val deeds = core.texture2D(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool.REALM, 8, 6, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format.R8UI)!!
        val far = core.texture2D(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool.REALM, 8, 6, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format.R8)!!
        minimap.createGl()
        minimap.setPoints(2, doubleArrayOf(3.5, 4.5), doubleArrayOf(2.5, 3.5), intArrayOf(0, 1), false)
        val view = RealmView().apply { dpr = 2.0; viewW = 457.0; viewH = 1017.0; s = 10.0; x = 30.0; y = 40.0; targetW = 914; targetH = 2034
            rectX0 = 7.0; rectY0 = 0.0; rectX1 = 52.7; rectY1 = 101.7 }
        check(rig.begin()); minimap.flush(); core.beginScreen(0f, 0f, 0f, 1f)
        minimap.draw(p.minimap, p.dots, chart, deeds, far, view, 2034)
        rig.end()
        val draws = rig.gl.draws.filter { it.framebuffer == 0 }
        assertEquals(2, draws.size, "the chart pass and one instanced dots draw")
        assertTrue(draws.all { it.scissor && it.scissorW == 264 && it.scissorH == 200 }, "132 × 100 CSS px at dpr 2")
        assertEquals(2, draws[1].instances)
        assertEquals(listOf(0, 0, 914, 2034), rig.gl.viewportBox.toList())
        assertTrue(!rig.gl.scissorTest)
        assertEquals(GL20.GL_ONE_MINUS_SRC_ALPHA, rig.gl.blendDstRgb, "the dots blend")
    }
}
