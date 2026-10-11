package gg.pixelkingdomwars.nativeclient.renderer.globe2

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import kotlin.math.abs
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/** Reads the goldens `tools/globe2-pin.mjs` exported from the pinned web implementation. */
internal object Goldens {
    fun json(name: String): JsonValue =
        JsonReader().parse(requireNotNull(Goldens::class.java.getResourceAsStream("/world/globe2/$name")) { "missing golden $name" }.reader(Charsets.UTF_8).readText())
    fun bytes(name: String): ByteArray = requireNotNull(Goldens::class.java.getResourceAsStream("/world/globe2/$name")) { "missing $name" }.readBytes()
    fun d3(v: JsonValue): DoubleArray = doubleArrayOf(v.getDouble(0), v.getDouble(1), v.getDouble(2))
}

/**
 * The flat globe's camera against the web implementation's own numbers (GLOBE-NATIVE-PLAN §7 "globe camera", 1e-9
 * relative): main.js computeView / hitSphere / projectDir / grab / fitAlt / minAltAt / altOf / fovY / EASE, cut out of
 * the pinned main.js and run by tools/globe2-pin.mjs. Why it matters: the HUD's labels, the dive's scale continuity
 * (sStart) and every tap's pick read these, and the realm map opens at the globe's own px per deed.
 *
 * Tolerances: the web stores matrices in Float32Arrays (persp, lookAt, mul4, inv4), so matrix entries and whatever is
 * derived through them (hits, projections, grabs) may differ from the port by a float ulp where V8's and the JVM's
 * libm round a transcendental differently; they are compared at 3 float ulps (and 1e-5 for derived doubles). Pure
 * double paths (altOf, fovY, EASE, fitAlt, minAltAt) are compared at 1e-9 relative.
 */
class GlobeCameraGoldenTest {
    private val g = Goldens.json("camera.json")

    private fun near(expected: Double, actual: Double, rel: Double, what: String) =
        assertTrue(abs(expected - actual) <= rel * maxOf(1.0, abs(expected)), "$what: web $expected, native $actual")

    @Test fun `the pin's constants are the generated ones`() {
        val k = g.get("constants")
        assertEquals(k.getDouble("altMax"), GlobeV2Pin.ALT_MAX); assertEquals(k.getDouble("altMin"), GlobeV2Pin.ALT_MIN)
        assertEquals(k.getDouble("fovRad"), GlobeV2Pin.FOV_RAD); assertEquals(k.getDouble("altMinAtlas"), GlobeV2Pin.ALT_MIN_ATLAS)
        assertEquals(k.getDouble("diveAlt"), GlobeV2Pin.DIVE_ALT); assertEquals(k.getDouble("cloudShell"), GlobeV2Pin.CLOUD_SHELL)
        assertEquals(g.getString("pin"), GlobeV2Pin.PIN)
    }

    @Test fun `altitude, field of view and the ease curves match the web`() {
        val cam = GlobeCameraV2()
        for (a in g.get("alts")) near(a.getDouble(1), cam.altOf(a.getDouble(0)), 1e-10, "altOf(${a.getDouble(0)})")
        for (f in g.get("fovs")) near(f.getDouble(2), cam.fovY(f.getDouble(0), f.getDouble(1)), 1e-10, "fovY(${f.getDouble(0)}, ${f.getDouble(1)})")
        for (e in g.get("eases")) {
            val ease = GlobeEase.valueOf(e.getString(0).uppercase())
            e.get(1).forEachIndexed { i, v -> near(v.asDouble(), ease.at(i / 20.0), 1e-10, "EASE.${e.getString(0)}(${i / 20.0})") }
        }
    }

    @Test fun `computeView, hitSphere and projectDir match the web on every case`() {
        var hits = 0; var misses = 0; var projected = 0
        for (c in g.get("cases")) {
            val cam = GlobeCameraV2()
            V.copy(cam.t, Goldens.d3(c.get("t"))); cam.z = c.getDouble("z"); cam.zT = cam.z
            cam.lensX = c.get("lens").getDouble(0); cam.lensY = c.get("lens").getDouble(1)
            val w = c.getInt("W"); val h = c.getInt("H")
            val v = cam.computeView(w, h)
            val where = "case ${w}x$h z=${cam.z}"
            // (the goldens are rounded to 12 decimals: 1e-10 is the tightest honest comparison of a double)
            near(c.getDouble("alt"), v.alt, 1e-10, "$where alt")
            near(c.getDouble("pxPerRad"), v.pxPerRad, 1e-10, "$where pxPerRad")
            for (i in 0 until 3) { near(c.get("eye").getDouble(i), v.eye[i], 1e-10, "$where eye"); near(c.get("right").getDouble(i), v.right[i], 1e-9, "$where right"); near(c.get("up").getDouble(i), v.up[i], 1e-9, "$where up") }
            for (i in 0 until 16) {
                val web = c.get("VP").getDouble(i); val inv = c.get("inv").getDouble(i)
                assertTrue(abs(web - v.vp[i]) <= 3 * Math.ulp(web.toFloat()) + 1e-12, "$where VP[$i]: web $web, native ${v.vp[i]}")
                assertTrue(abs(inv - v.inv[i]) <= 3 * Math.ulp(inv.toFloat()) + 1e-12, "$where inv[$i]: web $inv, native ${v.inv[i]}")
            }
            val out = DoubleArray(3)
            for (hsample in c.get("hits")) {
                val ok = cam.hitSphere(hsample.getDouble(0), hsample.getDouble(1), out)
                val web = hsample.get(2)
                if (web.isNull) { assertFalse(ok, "$where hit (${hsample.getDouble(0)}, ${hsample.getDouble(1)}) should miss"); misses++ }
                else { assertTrue(ok, "$where hit should land"); for (i in 0 until 3) near(web.getDouble(i), out[i], 1e-5, "$where hit"); hits++ }
            }
            val xy = DoubleArray(2)
            for (p in c.get("projections")) {
                val ok = cam.projectDir(Goldens.d3(p.get(0)), 0.0, xy)
                val web = p.get(1)
                if (web.isNull) assertFalse(ok, "$where projection should be culled")
                else { assertTrue(ok, "$where projection should show"); near(web.getDouble(0), xy[0], 1e-5, "$where x"); near(web.getDouble(1), xy[1], 1e-5, "$where y"); projected++ }
            }
        }
        assertTrue(hits > 100 && misses > 100 && projected > 100, "the golden set exercises both outcomes: $hits hits, $misses misses, $projected projections")
    }

    @Test fun `grab rotates the globe exactly as the web's arcball and off-sphere pan`() {
        var arcball = 0; var pans = 0
        for (c in g.get("grabs")) {
            val cam = GlobeCameraV2()
            V.copy(cam.t, Goldens.d3(c.get("t0"))); cam.z = c.getDouble("z")
            cam.computeView(c.getInt("W"), c.getInt("H"))
            val w = DoubleArray(3)
            val ok = cam.grab(c.get("from").getDouble(0), c.get("from").getDouble(1), c.get("to").getDouble(0), c.get("to").getDouble(1), w)
            for (i in 0 until 3) near(c.get("t1").getDouble(i), cam.t[i], 1e-5, "grab t1")
            if (c.get("step").isNull) { assertFalse(ok); pans++ } else { assertTrue(ok); for (i in 0 until 3) near(c.get("step").getDouble(i), w[i], 1e-5, "grab step"); arcball++ }
        }
        assertTrue(arcball > 5 && pans > 5, "both grab paths are exercised: $arcball arcball, $pans pan")
    }

    @Test fun `fitAlt frames a realm's outline like the web`() {
        for (c in g.get("fits")) {
            val cam = GlobeCameraV2(); cam.zLo = c.getDouble("zLo")
            val pts = c.get("pts"); val packed = DoubleArray(pts.size * 3)
            pts.forEachIndexed { i, p -> packed[i * 3] = p.getDouble(0); packed[i * 3 + 1] = p.getDouble(1); packed[i * 3 + 2] = p.getDouble(2) }
            val alt = cam.fitAlt(packed, pts.size, Goldens.d3(c.get("c")), c.getDouble("hw"), c.getDouble("hh"), c.getDouble("lo"), c.getDouble("W"), c.getDouble("H"))
            near(c.getDouble("alt"), alt, 1e-9, "fitAlt")
        }
    }

    @Test fun `minAltAt lowers the floor only near Phase E art, and only with that layer on (RG-3)`() {
        val on = GlobeCameraV2().apply { phaseE = true }; val off = GlobeCameraV2()
        var lowered = 0
        for (m in g.get("minAlts")) {
            val d = Goldens.d3(m.get(0)); val web = m.getDouble(1)
            near(web, on.minAltAt(d), 1e-9, "minAltAt")
            assertEquals(GlobeV2Pin.ALT_MIN_ATLAS, off.minAltAt(d), "with Phase E off the atlas floor holds everywhere")
            if (web < GlobeV2Pin.ALT_MIN_ATLAS) lowered++
        }
        assertTrue(lowered >= 3, "the goldens include points over the Phase E art")
    }

    @Test fun `a flight follows the eased slerp and lands exactly, and reduced motion cuts it`() {
        val cam = GlobeCameraV2(); cam.computeView(914, 2034)
        val target = V.dirOf(-115.0, 38.0)
        val dur = cam.flyTo(target, 0.6, 1000.0)
        assertTrue(dur in GlobeV2Pin.FLIGHT_MS..GlobeV2Pin.FLIGHT_MAX_MS)
        var t = 1000.0
        while (cam.flying) { t += 16.0; cam.step(t, 0.016, 1.0) }
        for (i in 0 until 3) near(target[i], cam.t[i], 1e-12, "landing")
        assertEquals(0.6, cam.z, 1e-12)
        val cut = GlobeCameraV2().apply { reducedMotion = true }
        assertEquals(1.0, cut.flyTo(target, 0.3, 0.0), "reduced motion: cut, don't fly")
    }

    @Test fun `inertia decays to a stop and the zoom floor holds`() {
        val cam = GlobeCameraV2(); cam.computeView(914, 2034)
        V.set(cam.vel, 0.0, 2.0, 0.0); cam.hasVel = true
        var t = 0.0; var steps = 0
        while (cam.hasVel && steps < 1000) { t += 16.0; cam.step(t, 0.016, 1.0); steps++ }
        assertFalse(cam.hasVel, "inertia stops"); assertTrue(steps in 20..400, "decays over a human time: $steps frames")
        cam.zT = 1.0
        val floor = cam.zOf(GlobeV2Pin.ALT_MIN_ATLAS)
        repeat(200) { t += 16.0; cam.step(t, 0.016, floor) }
        assertTrue(cam.z <= floor + 1e-12 && cam.zT <= floor + 1e-12, "the camera never passes the atlas floor over a realm without a map")
    }
}
