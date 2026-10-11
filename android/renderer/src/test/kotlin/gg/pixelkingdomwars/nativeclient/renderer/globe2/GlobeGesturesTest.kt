package gg.pixelkingdomwars.nativeclient.renderer.globe2

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The globe's gestures on synthetic traces (GLOBE-NATIVE-PLAN §3.7, §8.2), at a non-1 px scale (the Seeker's buffer is
 * ~2.6 px per CSS px, so every web px threshold must scale): a still press is a tap, a drag past the slop turns the globe
 * under the finger and flings on release, a spread pinch zooms in about the fingers, any touch stops a flight.
 */
class GlobeGesturesTest {
    private val scale = 2.625
    private fun rig(): Triple<GlobeCameraV2, GlobeGestures, MutableList<DoubleArray>> {
        val cam = GlobeCameraV2(scale); cam.z = 0.3; cam.computeView(914, 2034)
        val taps = ArrayList<DoubleArray>()
        return Triple(cam, GlobeGestures(cam) { x, y, t -> taps += doubleArrayOf(x, y, t) }, taps)
    }

    @Test fun `a still press is a tap, a slow one is not`() {
        val (_, g, taps) = rig()
        g.down(1, 457.0, 1017.0, 0.0); g.move(1, 457.0 + 5 * scale, 1017.0, 50.0); g.up(1, 457.0, 1017.0, 100.0)
        assertEquals(1, taps.size, "within the slop (6 CSS px × scale) it stays a tap")
        g.down(1, 457.0, 1017.0, 1000.0); g.up(1, 457.0, 1017.0, 1000.0 + GlobeV2Pin.TAP_MS + 1)
        assertEquals(1, taps.size, "a press longer than the tap time is not a tap")
    }

    @Test fun `a drag turns the globe under the finger and a quick release flings`() {
        val (cam, g, taps) = rig()
        val before = cam.t.copyOf()
        var t = 0.0; var x = 457.0
        g.down(1, x, 1017.0, t)
        repeat(12) { t += 8.0; x += 30.0; g.move(1, x, 1017.0, t); cam.computeView(914, 2034) }
        g.up(1, x, 1017.0, t + 8)
        assertTrue(taps.isEmpty())
        assertTrue(V.dot(before, cam.t) < 0.9999, "the globe turned")
        assertTrue(cam.hasVel, "a quick release keeps turning (inertia from the last 90 ms)")
        assertTrue(V.len(cam.vel) >= GlobeV2Pin.VEL_MIN)
    }

    @Test fun `a slow drag does not fling`() {
        val (cam, g, _) = rig()
        var t = 0.0; var x = 457.0
        g.down(1, x, 1017.0, t)
        repeat(10) { t += 8.0; x += 30.0; g.move(1, x, 1017.0, t); cam.computeView(914, 2034) }
        g.up(1, x, 1017.0, t + 400) // held still, then lifted: the samples older than 90 ms are gone
        assertFalse(cam.hasVel)
    }

    @Test fun `spreading two fingers zooms in, pinching zooms out`() {
        val (cam, g, _) = rig()
        val z0 = cam.z
        g.down(1, 357.0, 1017.0, 0.0); g.down(2, 557.0, 1017.0, 0.0)
        g.move(2, 657.0, 1017.0, 16.0); cam.computeView(914, 2034)
        assertTrue(cam.z > z0, "spread zooms in")
        val z1 = cam.z
        g.move(2, 400.0, 1017.0, 32.0)
        assertTrue(cam.z < z1, "pinch zooms out")
        assertEquals(cam.z, cam.zT, "a pinch sets the zoom directly (no easing lag)")
    }

    @Test fun `any touch stops a flight and inertia`() {
        val (cam, g, _) = rig()
        cam.flyTo(V.dirOf(100.0, 10.0), 0.5, 0.0)
        V.set(cam.vel, 0.0, 1.0, 0.0); cam.hasVel = true
        g.down(1, 10.0, 10.0, 5.0)
        assertFalse(cam.flying); assertFalse(cam.hasVel)
    }
}
