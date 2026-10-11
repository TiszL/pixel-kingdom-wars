package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.world.FrameLadder
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRows
import gg.pixelkingdomwars.nativeclient.renderer.world.WebPin
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameCost
import kotlin.math.max
import kotlin.math.min
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test

/**
 * GlobeCost with teeth (GLOBE-NATIVE-PLAN §1.2: "Globe ≤ 12 fetches per canvas px, no full-screen procedural noise";
 * §5.2 GlobeCost). Why it matters: the owner's bar is 60 fps on the Seeker with bounded per-frame GPU work, and the only
 * pre-device proof is this count. The model is tied to the shader text (a new texture read in the pinned stages fails
 * the table test), and the budget is checked on real geometry: every Seeker row, the home view, every realm framed as
 * a selection frames it, every exploration island at the closest zoom, and 300 random views, with the island boxes the
 * 'globe-isles' vertex stage would draw (so overlapping boxes, which add fetches per pixel, are counted where they
 * really overlap).
 */
class GlobeCostTest {
    private val ladder = FrameLadder(LadderPolicy.PLAN, WebPin.LADDER_INPUTS)
    private fun stage(name: String) = Goldens.bytes("shaders/$name").toString(Charsets.UTF_8)
    private fun code(s: String) = s.replace(Regex("""/\*[\s\S]*?\*/"""), " ").replace(Regex("//[^\n]*"), "")
    private fun body(s: String) = code(s).substringAfter("void main(){")

    @Test fun `the fetch table is the shader's own texture reads`() {
        val flat = body(stage("globe-flat.fs.glsl"))
        // cubeTex: albedo, sea/shore/glow, cloud shadow, cloud shell; selField: the selection field (one read either mode)
        assertEquals(4, Regex("""cubeTex\(""").findAll(flat).count())
        assertEquals(1, Regex("""selField\(""").findAll(flat).count())
        assertEquals(5, GlobeCost.flatFetches(true, GlobeCost.Config(selection = true, clouds = true)))
        assertEquals(0, GlobeCost.flatFetches(false, GlobeCost.Config(selection = true, clouds = true)), "sky fragments read nothing")
        val isles = body(stage("globe-isles.fs.glsl"))
        assertEquals(1, Regex("""textureGrad\(uIsleArt""").findAll(isles).count())
        assertEquals(1, Regex("""cubeTex\(""").findAll(isles).count()); assertEquals(1, Regex("""selField\(""").findAll(isles).count())
        assertEquals(3, GlobeCost.isleFetches(true, GlobeCost.Config(selection = true, clouds = true)))
        // the atlas read sits after the box test, the land reads after the sea discard (fetches only where they count)
        assertTrue(isles.indexOf("discard") < isles.indexOf("textureGrad(uIsleArt"), "the box test comes before the atlas read")
        assertTrue(isles.indexOf("textureGrad(uIsleArt") < isles.lastIndexOf("discard") && isles.lastIndexOf("discard") < isles.indexOf("cubeTex("), "sea texels leave before the land reads")
        val fx = code(stage("globe-fx.fs.glsl")) + body(stage("globe-fx.vs.glsl"))
        assertTrue(!Regex("""texture\w*\(""").containsMatchIn(fx), "the feature points read no texture")
        // no procedural noise anywhere in the globe's stages (plan §4.6): no fbm/vnoise/worley
        for (s in listOf("globe-flat.fs.glsl", "globe-isles.fs.glsl", "globe-fx.vs.glsl")) assertTrue(!Regex("""\b(fbm|vnoise|worley|ridged)\(""").containsMatchIn(code(stage(s))), s)
        // the selection field read in the helper is one texture call per mode
        val common = code(stage("globe-flat.fs.glsl")).substringAfter("vec2 selField(vec3 d){").substringBefore("float selFw(")
        assertEquals(2, Regex("""textureLod\(""").findAll(common).count(), "realm and island branches: one read each, never both")
    }

    @Test fun `the budget has teeth, six island boxes over one pixel would break it`() {
        val worst = GlobeCost.Config(selection = true, clouds = true)
        assertEquals(10, GlobeCost.worstFetchesPerPx(worst, 3), "5 flat + 3 boxes + 2 land reads")
        assertTrue(GlobeCost.worstFetchesPerPx(worst, 5) <= GlobeCost.BUDGET_FETCHES)
        assertTrue(GlobeCost.worstFetchesPerPx(worst, 6) > GlobeCost.BUDGET_FETCHES, "a model that could never fail would prove nothing")
    }

    @Test fun `every Seeker row, view and ladder level stays within 12 fetches per canvas px and 10 ms at L0`() {
        val islands = islands()
        var views = 0; var worstOverlap = 0
        for (row in SeekerRows.ALL) {
            val w = row.bufferW; val h = row.bufferH
            for ((name, cam) in views(w, h, row.dpr, islands)) {
                val v = cam.computeView(w, h)
                val boxes = boxes(v, islands)
                val overlap = maxOverlap(boxes)
                worstOverlap = max(worstOverlap, overlap)
                val area = boxes.sumOf { (min(it[2], 1.0) - max(it[0], -1.0)).coerceAtLeast(0.0) * (min(it[3], 1.0) - max(it[1], -1.0)).coerceAtLeast(0.0) } / 4
                val sphere = sphereCoverage(cam, w, h)
                for (level in 0..3) {
                    val knobs = ladder.knobs[level]
                    for (selection in listOf(false, true)) {
                        val c = GlobeCost.config(knobs, selection)
                        val worst = GlobeCost.worstFetchesPerPx(c, overlap)
                        assertTrue(worst <= GlobeCost.BUDGET_FETCHES, "$name on $row L$level selection=$selection: $overlap boxes over one px → $worst fetches")
                        val frame = GlobeCost.frame(knobs, selection, w, h, sphere, area, 8432)
                        assertTrue(frame.fetchesPerCanvasPx <= GlobeCost.BUDGET_FETCHES, "$name on $row: ${frame.fetchesPerCanvasPx} fetches per canvas px")
                        if (level == 0) assertTrue(frame.ms <= WorldFrameCost.BUDGET_MS, "$name on $row: ${frame.ms} ms at L0")
                    }
                }
                views++
            }
        }
        assertTrue(views >= 3 * (1 + 8 + 32 + 300), "views checked: $views")
        assertTrue(worstOverlap >= 1, "the sweep reaches island boxes (worst overlap $worstOverlap)")
    }

    /**
     * D-172: the Phase E islands add three more 'globe-isles' boxes (their art is the same program, one atlas read per box
     * and the land reads once), and the camera may come down to ALT_MIN over them (main.js minAltAt), where one box
     * fills the screen. The same budget holds on every Seeker row: at each island's own floor, at the atlas floor, framed
     * as a selection frames it, at its art's edge, and in 100 random views around each island, with all 35 boxes counted
     * where the vertex stage would really draw them.
     */
    @Test fun `with the Phase E islands on every Seeker row and view still stays within 12 fetches per canvas px and 10 ms at L0`() {
        val all = islands() + phaseEIslands()
        val pe = phaseEIslands()
        var views = 0; var worstOverlap = 0; var phaseEOnScreen = 0
        for (row in SeekerRows.ALL) {
            val w = row.bufferW; val h = row.bufferH
            for ((name, cam) in views(w, h, row.dpr, islands()) + phaseEViews(w, h, row.dpr)) {
                val v = cam.computeView(w, h)
                val boxes = boxes(v, all)
                val overlap = maxOverlap(boxes)
                worstOverlap = max(worstOverlap, overlap)
                if (boxes(v, pe).isNotEmpty()) phaseEOnScreen++
                val area = boxes.sumOf { (min(it[2], 1.0) - max(it[0], -1.0)).coerceAtLeast(0.0) * (min(it[3], 1.0) - max(it[1], -1.0)).coerceAtLeast(0.0) } / 4
                val sphere = sphereCoverage(cam, w, h)
                for (level in 0..3) {
                    val knobs = ladder.knobs[level]
                    for (selection in listOf(false, true)) {
                        val c = GlobeCost.config(knobs, selection)
                        val worst = GlobeCost.worstFetchesPerPx(c, overlap)
                        assertTrue(worst <= GlobeCost.BUDGET_FETCHES, "$name on $row L$level selection=$selection: $overlap boxes over one px → $worst fetches")
                        val frame = GlobeCost.frame(knobs, selection, w, h, sphere, area, 8432)
                        assertTrue(frame.fetchesPerCanvasPx <= GlobeCost.BUDGET_FETCHES, "$name on $row: ${frame.fetchesPerCanvasPx} fetches per canvas px")
                        if (level == 0) assertTrue(frame.ms <= WorldFrameCost.BUDGET_MS, "$name on $row: ${frame.ms} ms at L0 (isle boxes $area)")
                    }
                }
                views++
            }
        }
        assertTrue(views >= 3 * (1 + 8 + 32 + 300 + 3 * (4 + 100)), "views checked: $views")
        assertTrue(phaseEOnScreen >= 3 * 3 * 104, "the sweep really draws the Phase E boxes ($phaseEOnScreen views)")
        assertTrue(worstOverlap >= 1, "worst overlap $worstOverlap")
    }

    /**
     * The near slot (the displayed one of the two resident since 2026-09-27) swaps one island's texture, never its
     * geometry: every instance record the layer can draw is one of the three islands in exactly its own box (so the
     * sweep above, which counts the three boxes, is the near slot's cost too), and no draw set ever holds an island
     * twice (the far draw leaves the near island out).
     */
    @Test fun `the near slot draws an island in its own box and never twice, so the Phase E cost is unchanged`() {
        val d = PhaseEIslandLayer.RECORDS; val n = GlobeV2Pin.PHASE_E.size
        assertEquals((n + n * (n - 1) + n) * 8, d.size)
        fun box(r: Int) = (0 until 4).map { d[r * 8 + it] }
        val own = (0 until n).map { box(it) }
        for (r in 0 until d.size / 8) assertTrue(box(r) in own, "record $r is an island's own box")
        for (i in 0 until n) {
            val without = (0 until n - 1).map { box(n + i * (n - 1) + it) }
            assertEquals(own.filterIndexed { j, _ -> j != i }, without, "all but island $i")
            val near = n + n * (n - 1) + i
            assertEquals(own[i], box(near)); assertEquals(0f, d[near * 8 + 4], "the near slot's texture has one layer")
        }
    }

    /** Views over the Phase E islands with that layer on (the camera floor lowered near their art, main.js minAltAt). */
    private fun phaseEViews(w: Int, h: Int, dpr: Double): List<Pair<String, GlobeCameraV2>> {
        val out = ArrayList<Pair<String, GlobeCameraV2>>()
        val rnd = java.util.Random(0x0d_172)
        for (s in GlobeV2Pin.PHASE_E) {
            fun cam(lon: Double, lat: Double, alt: Double?) = GlobeCameraV2(dpr).also { it.phaseE = true; it.computeView(w, h); V.dirOf(it.t, lon, lat); it.z = it.zOf(alt ?: it.minAltAt(it.t)) }
            out += "${s.id} at its floor" to cam(s.lon, s.lat, null)
            out += "${s.id} at the atlas floor" to cam(s.lon, s.lat, GlobeV2Pin.ALT_MIN_ATLAS)
            out += "${s.id} at its art's edge" to cam(s.lon + s.wDeg * 0.45 / kotlin.math.cos(s.lat * V.RAD), s.lat, null)
            // framed as GlobeV2Renderer.selectIsland frames it (the tap ellipse × 1.7, floor 0.2) above a portrait sheet
            val c = V.dirOf(s.lon, s.lat); val cl = kotlin.math.cos(s.lat * V.RAD); val pts = DoubleArray(24 * 3)
            for (a in 0 until 24) { val d = V.dirOf(s.lon + kotlin.math.cos(a / 24.0 * 2 * Math.PI) * s.rx * 1.7 / cl, s.lat + kotlin.math.sin(a / 24.0 * 2 * Math.PI) * s.ry * 1.7); d.copyInto(pts, a * 3) }
            val framed = GlobeCameraV2(dpr).also { it.phaseE = true; it.computeView(w, h) }
            val alt = framed.fitAlt(pts, 24, c, w / 2.0 - 36 * dpr, h * 0.3 - 36 * dpr, 0.2, w.toDouble(), h.toDouble())
            V.copy(framed.t, c); framed.z = framed.zOf(alt)
            out += "${s.id} selected" to framed
            repeat(100) {
                val lon = s.lon + (rnd.nextDouble() * 2 - 1) * s.wDeg * 1.2 / cl; val lat = s.lat + (rnd.nextDouble() * 2 - 1) * s.wDeg * 1.2
                val r = GlobeCameraV2(dpr).also { it.phaseE = true; it.computeView(w, h); V.dirOf(it.t, lon, lat) }
                r.z = rnd.nextDouble() * r.zOf(r.minAltAt(r.t))
                out += "${s.id} random $it" to r
            }
        }
        return out
    }

    @Test fun `L1 cuts the flat pass by dropping the cloud shell and its shadow`() {
        val l0 = GlobeCost.config(ladder.knobs[0], true); val l1 = GlobeCost.config(ladder.knobs[1], true)
        assertTrue(GlobeCost.flatFetches(true, l1) <= 0.8 * GlobeCost.flatFetches(true, l0), "L0 ${GlobeCost.flatFetches(true, l0)} → L1 ${GlobeCost.flatFetches(true, l1)} fetches")
    }

    @Test fun `L2 and L3 draw the flat pass at half scale behind one upscale read`() {
        for (level in 0..3) {
            val c = GlobeCost.config(ladder.knobs[level], true)
            val passes = GlobeCost.passes(c, 0.6, 0.02, 10)
            val flat = passes.filter { it.name.startsWith("globe-flat") }
            if (level < 2) {
                assertEquals(1.0, c.scale); assertTrue(passes.none { it.onGround || it.name == "globe-lowres-blit" }, "L$level: full scale")
            } else {
                assertEquals(GlobeCost.HALF_SCALE, c.scale)
                assertTrue(flat.all { it.onGround }, "L$level: the flat pass is a k× target pass")
                assertEquals(1, passes.count { it.name == "globe-lowres-blit" && it.coverage == 1.0 })
            }
        }
        // the upscale is the realm engine's pinned blit: one texture read per screen px (textureSize is a query)
        val shaders = gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
        val blit = code(shaders.source(shaders.realm.getValue(GlobeV2Renderer.PROGRAM_BLIT).fs)).substringAfter("void main()")
        assertEquals(GlobeCost.BLIT_FETCHES, Regex("""\btexture\s*\(""").findAll(blit).count())
    }

    // ---- geometry: the island boxes exactly as GLOBE_ISLES_VS computes them --------------------------------------

    /** An island box as the vertex stage sees it: centre, rx/ry (degrees) and the uIsleGrid.z extent of its draw. */
    private class Isle(val lon: Double, val lat: Double, val rx: Double, val ry: Double, val ext: Double)

    private fun islands(): List<Isle> {
        val j = Goldens.json("islands.json"); val extent = j.get("shape").getDouble("extent")
        return j.get("chains").flatMap { c -> c.get("islands").map { Isle(it.getDouble("lon"), it.getDouble("lat"), it.getDouble("rx"), it.getDouble("ry"), extent) } }
    }

    /** The Phase E boxes exactly as [PhaseEIslandLayer] uploads them (extent 1: its rx, ry are the box). */
    private fun phaseEIslands(): List<Isle> = GlobeV2Pin.PHASE_E.indices.map { i ->
        val d = PhaseEIslandLayer.RECORDS // the first three records: every island at its own layer
        Isle(d[i * 8].toDouble(), d[i * 8 + 1].toDouble(), d[i * 8 + 2].toDouble(), d[i * 8 + 3].toDouble(), 1.0)
    }

    private fun views(w: Int, h: Int, dpr: Double, islands: List<Isle>): List<Pair<String, GlobeCameraV2>> {
        val out = ArrayList<Pair<String, GlobeCameraV2>>()
        val home = GlobeCameraV2(dpr).also { it.computeView(w, h); val cy = DoubleArray(1); val alt = it.homeFrame(w.toDouble(), h.toDouble(), 100 * dpr, FloatArray(0), 0, cy); it.z = it.zOf(alt) }
        out += "home" to home
        val geography = GlobeGeography.fromMasks(Goldens.bytes("surface-mask.png"), Goldens.bytes("realm-mask.png"))!!
        for (r in GlobeV2Pin.REALMS.indices) {
            val g = geography.realmGeom(r)
            val cam = GlobeCameraV2(dpr); cam.computeView(w, h)
            val alt = cam.fitAlt(g.pts, g.count, g.c, w / 2.0 - 36 * dpr, h * 0.3 - 36 * dpr, GlobeV2Pin.REALM_FOCUS_ALT, w.toDouble(), h.toDouble())
            V.copy(cam.t, g.c); cam.z = cam.zOf(alt)
            out += "realm ${GlobeV2Pin.REALMS[r].id}" to cam
        }
        for ((i, isle) in islands.withIndex()) {
            val cam = GlobeCameraV2(dpr); V.dirOf(cam.t, isle.lon, isle.lat); cam.z = cam.zOf(GlobeV2Pin.ALT_MIN_ATLAS)
            out += "island $i at the floor" to cam
        }
        val rnd = java.util.Random(0x61_0be)
        repeat(300) {
            val cam = GlobeCameraV2(dpr)
            V.dirOf(cam.t, -180 + rnd.nextDouble() * 360, -80 + rnd.nextDouble() * 160); cam.z = rnd.nextDouble() * cam.zOf(GlobeV2Pin.ALT_MIN_ATLAS)
            out += "random $it" to cam
        }
        return out
    }

    /** NDC boxes [x0, y0, x1, y1] of every island the vertex stage would not cull. */
    private fun boxes(v: GlobeView, islands: List<Isle>): List<DoubleArray> {
        val out = ArrayList<DoubleArray>(); val m = v.vp
        val en = V.norm(DoubleArray(3), v.eye); val invLen = 1 / V.len(v.eye)
        for (isle in islands) {
            var lx = 1e9; var ly = 1e9; var hx = -1e9; var hy = -1e9; var front = -1e9
            for (i in 0 until 9) {
                val kx = (i % 3) - 1.0; val ky = (i / 3) - 1.0
                val p = V.dirOf(isle.lon + kx * isle.rx * isle.ext, isle.lat + ky * isle.ry * isle.ext)
                val cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]; val cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]
                val cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
                if (cw > 1e-4) { lx = min(lx, cx / cw); ly = min(ly, cy / cw); hx = max(hx, cx / cw); hy = max(hy, cy / cw) }
                front = max(front, V.dot(p, en) - invLen)
            }
            val px = (hx - lx) * .12 + .01; val py = (hy - ly) * .12 + .01
            lx -= px; ly -= py; hx += px; hy += py
            if (front < -.02 || hx < -1 || lx > 1 || hy < -1 || ly > 1) continue
            out += doubleArrayOf(lx, ly, hx, hy)
        }
        return out
    }

    /** The most boxes any on-screen point lies in (the maximum occurs at some pair of box corners). */
    private fun maxOverlap(b: List<DoubleArray>): Int {
        var best = 0
        for (a in b) for (c in b) {
            val x = max(a[0], -1.0) + 1e-9; val y = max(c[1], -1.0) + 1e-9
            if (x > 1 || y > 1) continue
            var n = 0; for (r in b) if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) n++
            best = max(best, n)
        }
        return best
    }

    private fun sphereCoverage(cam: GlobeCameraV2, w: Int, h: Int): Double {
        var n = 0; val out = DoubleArray(3); val sx = 48; val sy = 96
        for (j in 0 until sy) for (i in 0 until sx) if (cam.hitSphere((i + .5) * w / sx, (j + .5) * h / sy, out)) n++
        return n.toDouble() / (sx * sy)
    }
}
